"""M25 email-verification vendor adapter (LLD M25 "Per kind": "the email-verification vendor,
which maps deliverable→valid, risky/catch-all→risky, undeliverable→invalid, and error→unknown").

Like M21's customs connector, the concrete vendor is still to be chosen [assumption]. This module
defines the ``EmailVerifier`` protocol the rest of M25 depends on and a generic JSON/REST adapter
that any "send an email, get back a deliverability verdict" vendor can be wired to via two secrets
(``EMAIL_VERIFY_API_URL``, ``EMAIL_VERIFY_API_KEY``). When those secrets are not configured the
adapter degrades to ``unknown`` for every address rather than guessing — the same "Unavailable is a
value" discipline M23 uses for its own vendors.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from kp.m01_platform import KpError, get_logger, get_secret, record_cost

from .models import DeliverabilityStatus

_log = get_logger("kp.m25_freshness.email_vendor")

VENDOR_NAME = "email_verify"
DEFAULT_TIMEOUT_S = 5.0          # [tunable]
COST_MICROS_INR_PER_CHECK = 40_000  # [tunable, assumption] ~0.04 INR/check pending the real vendor's pricing

URL_SECRET = "EMAIL_VERIFY_API_URL"
KEY_SECRET = "EMAIL_VERIFY_API_KEY"

# Vendor-reported result strings -> our vocabulary (LLD M25 mapping). Vendors differ in casing and
# in whether "catch-all" is spelled with a hyphen or an underscore, so both are covered.
_STATUS_MAP: dict[str, DeliverabilityStatus] = {
    "deliverable": "valid",
    "valid": "valid",
    "risky": "risky",
    "catch-all": "risky",
    "catch_all": "risky",
    "catchall": "risky",
    "unknown": "unknown",
    "undeliverable": "invalid",
    "invalid": "invalid",
    "error": "unknown",
}


class EmailVerifier(Protocol):
    def verify(self, email: str) -> DeliverabilityStatus: ...


def map_vendor_result(raw: str | None) -> DeliverabilityStatus:
    return _STATUS_MAP.get((raw or "").strip().lower(), "unknown")


def _secret_or_none(name: str) -> str | None:
    try:
        v = get_secret(name)
    except KpError:
        return None
    return v.strip() or None


@dataclass(frozen=True)
class GenericEmailVerifier:
    """A generic REST adapter: ``GET {url}?email=<email>&api_key=<key>`` returning
    ``{"result": "<deliverable|risky|catch_all|undeliverable|unknown>"}`` (or a ``"status"`` key —
    both are read). Not configured, a timeout, a network error or a non-2xx response all become
    ``'unknown'`` (LLD: "error → unknown"); nothing here is ever treated as ``'invalid'`` on a mere
    vendor hiccup, since that would wrongly negate a real contact.
    """

    timeout_s: float = DEFAULT_TIMEOUT_S

    def verify(self, email: str) -> DeliverabilityStatus:
        base = _secret_or_none(URL_SECRET)
        key = _secret_or_none(KEY_SECRET)
        if base is None or key is None:
            _log.info("email verification vendor is not configured; reporting unknown")
            return "unknown"
        import httpx

        try:
            resp = httpx.get(base, params={"email": email, "api_key": key}, timeout=self.timeout_s)
        except httpx.HTTPError as e:
            _log.info("email verification vendor call failed", extra={"error": type(e).__name__})
            return "unknown"
        finally:
            record_cost(vendor=VENDOR_NAME, op="verify", units=1, cost_micros_inr=COST_MICROS_INR_PER_CHECK)
        if resp.status_code != 200:
            return "unknown"
        try:
            body: Any = resp.json()
        except ValueError:
            return "unknown"
        if not isinstance(body, dict):
            return "unknown"
        raw = body.get("result") or body.get("status")
        return map_vendor_result(raw if isinstance(raw, str) else None)


_default: EmailVerifier | None = None


def default_email_verifier() -> EmailVerifier:
    global _default
    if _default is None:
        _default = GenericEmailVerifier()
    return _default


def set_email_verifier_for_testing(verifier: EmailVerifier | None) -> None:
    global _default
    _default = verifier


__all__ = [
    "COST_MICROS_INR_PER_CHECK",
    "KEY_SECRET",
    "URL_SECRET",
    "VENDOR_NAME",
    "EmailVerifier",
    "GenericEmailVerifier",
    "default_email_verifier",
    "map_vendor_result",
    "set_email_verifier_for_testing",
]
