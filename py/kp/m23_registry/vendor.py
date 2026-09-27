"""Shared plumbing for M23 vendor calls.

Every call:
1. checks the M08 licence register (source active, and allowed for the subject's country);
2. checks the vendor's M01 budget flag;
3. takes a token from the vendor's rate class;
4. fetches through the M08 HTTP helper (prohibited hosts, robots.txt, identifying user agent).

Failures surface as ``VendorFailure`` carrying an ``Unavailable`` reason; the public API turns
them into ``Unavailable`` values.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urljoin

from kp.m01_platform import KpError, assert_vendor_budget, get_logger, record_cost
from kp.m08_sources import HttpResponse, ProhibitedHost, RobotsDisallowed, SourceEntry, http_fetch, lookup_source

from .models import Unavailable, UnavailableReason
from .ratelimit import default_limiter

_log = get_logger("kp.m23_registry.vendor")

HTTP_TIMEOUT_S = 8.0  # [tunable] per request; M24 check budgets are 3 s, served mostly from cache
MAX_REDIRECTS = 3


class VendorFailure(Exception):
    def __init__(self, source: str, reason: UnavailableReason, detail: str | None = None) -> None:
        super().__init__(f"{source}: {reason}{' (' + detail + ')' if detail else ''}")
        self.source = source
        self.reason = reason
        self.detail = detail

    def as_unavailable(self) -> Unavailable:
        return Unavailable(source=self.source, reason=self.reason, detail=self.detail)


def require_source(source_id: str, region: str | None = None) -> SourceEntry:
    """The register row for ``source_id`` if it is active (and allowed for ``region``)."""
    try:
        entry = lookup_source(source_id)
    except KpError as e:
        raise VendorFailure(source_id, "upstream_error", f"licence register lookup failed: {e.code}") from e
    if entry is None or not entry.is_active():
        raise VendorFailure(source_id, "source_inactive",
                            "not registered" if entry is None else f"status {entry.status}")
    if region is not None and not entry.allows_region(region):
        raise VendorFailure(source_id, "region_not_allowed", region)
    return entry


def source_active(source_id: str) -> bool:
    try:
        entry = lookup_source(source_id)
    except KpError:
        return False
    return entry is not None and entry.is_active()


def gate(source_id: str, vendor: str) -> None:
    """Budget flag and rate token for one outbound call."""
    try:
        assert_vendor_budget(vendor)
    except KpError as e:
        raise VendorFailure(source_id, "budget_exceeded", e.code) from e
    if not default_limiter().acquire(vendor):
        raise VendorFailure(source_id, "rate_limited", vendor)


def note_call(vendor: str, op: str) -> None:
    """Records the call for cost attribution (the free registries cost 0; the count still matters)."""
    try:
        record_cost(vendor=vendor, op=op, units=1, cost_micros_inr=0)
    except Exception:  # noqa: BLE001 — cost telemetry must never fail a lookup
        _log.debug("cost event not recorded", extra={"vendor": vendor, "op": op})


@dataclass(frozen=True)
class JsonResponse:
    status: int
    url: str
    body: Any | None  # parsed JSON for 2xx responses with a JSON body, else None
    raw: HttpResponse


def fetch_json(
    source_id: str,
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    timeout: float = HTTP_TIMEOUT_S,
    follow_redirects: int = 0,
    log_url: bool = True,
) -> JsonResponse:
    """GET ``url`` through the M08 helper; follows up to ``follow_redirects`` redirects itself
    (every hop is again subject to the prohibited-host and robots checks).

    ``log_url=False`` keeps URLs that carry credentials in a query string out of logs and errors.
    """
    hdrs = {"accept": "application/json, application/rdap+json;q=0.9, */*;q=0.1", **dict(headers or {})}
    current = url
    for hop in range(follow_redirects + 1):
        try:
            resp = http_fetch(current, headers=hdrs, timeout=timeout)
        except (RobotsDisallowed, ProhibitedHost) as e:
            raise VendorFailure(source_id, "robots", _safe(current, log_url)) from e
        except KpError as e:
            raise VendorFailure(source_id, "upstream_error", f"{e.code} {_safe(current, log_url)}") from e
        if resp.status in (301, 302, 303, 307, 308) and hop < follow_redirects:
            loc = resp.headers.get("location")
            if not loc:
                raise VendorFailure(source_id, "upstream_error", "redirect without location")
            current = urljoin(current, loc)
            continue
        body: Any | None = None
        if 200 <= resp.status < 300 and resp.body:
            try:
                body = json.loads(resp.body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                raise VendorFailure(source_id, "upstream_error", "response is not JSON") from e
        return JsonResponse(status=resp.status, url=current, body=body, raw=resp)
    raise VendorFailure(source_id, "upstream_error", "too many redirects")


def _safe(url: str, log_url: bool) -> str:
    return url if log_url else url.split("?", 1)[0]


def expect_ok(source_id: str, r: JsonResponse, *, allow: tuple[int, ...] = ()) -> None:
    """Maps non-success statuses to failures. Statuses in ``allow`` are left to the caller."""
    if r.status in allow or 200 <= r.status < 300:
        return
    if r.status == 429:
        raise VendorFailure(source_id, "rate_limited", "vendor returned 429")
    if r.status in (401, 403):
        raise VendorFailure(source_id, "not_configured", f"vendor returned {r.status}")
    raise VendorFailure(source_id, "upstream_error", f"vendor returned {r.status}")


def text(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None
