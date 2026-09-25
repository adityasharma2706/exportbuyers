"""M08 base HTTP helper for connectors.

Every connector request goes through ``http_fetch``:
  * refuses prohibited hosts (LinkedIn and other sites whose terms forbid scraping);
  * checks robots.txt for our user agent — a disallowed URL raises ``RobotsDisallowed``;
  * honours a robots ``Crawl-delay`` per host (capped);
  * sends a user agent that identifies the product and a contact URL.
"""
from __future__ import annotations

import os
import threading
import time
import urllib.robotparser
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from kp.m01_platform import KpError, get_logger

from .register import is_prohibited_host

PRODUCT_NAME = "ExportBuyersBot"
PRODUCT_VERSION = "1.0"
DEFAULT_CONTACT_URL = "https://exportbuyers.in/bot"
ROBOTS_TTL_S = 24 * 3600.0  # [tunable]
MAX_CRAWL_DELAY_S = 30.0  # [tunable]
DEFAULT_TIMEOUT_S = 30.0
MAX_BODY_BYTES = 50 * 1024 * 1024  # [tunable]

_log = get_logger("kp.m08_sources.http")


def user_agent() -> str:
    contact = os.environ.get("KP_CRAWLER_CONTACT_URL") or DEFAULT_CONTACT_URL
    return f"{PRODUCT_NAME}/{PRODUCT_VERSION} (+{contact})"


class RobotsDisallowed(KpError):
    def __init__(self, url: str) -> None:
        super().__init__("POLICY_DENIED", "robots.txt disallows this URL", {"url": url, "reason": "robots"})
        self.url = url


class ProhibitedHost(KpError):
    def __init__(self, url: str, host: str) -> None:
        super().__init__("POLICY_DENIED", f"Host {host} is on the prohibited-source list",
                         {"url": url, "host": host, "reason": "prohibited_host"})
        self.url = url
        self.host = host


@dataclass(frozen=True)
class HttpResponse:
    url: str
    status: int
    headers: Mapping[str, str]
    body: bytes

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "application/octet-stream").split(";")[0].strip() or \
            "application/octet-stream"


# (method, url, headers, timeout) -> HttpResponse. Replaceable for tests.
Transport = Callable[[str, str, Mapping[str, str], float], HttpResponse]


def _httpx_transport(method: str, url: str, headers: Mapping[str, str], timeout: float) -> HttpResponse:
    import httpx

    try:
        with httpx.Client(follow_redirects=False, timeout=timeout) as client:
            with client.stream(method, url, headers=dict(headers)) as r:
                chunks: list[bytes] = []
                total = 0
                for chunk in r.iter_bytes():
                    total += len(chunk)
                    if total > MAX_BODY_BYTES:
                        raise KpError("VALIDATION", "Response body exceeds the size limit",
                                      {"url": url, "limit": MAX_BODY_BYTES})
                    chunks.append(chunk)
                return HttpResponse(url=str(r.url), status=r.status_code,
                                    headers={k.lower(): v for k, v in r.headers.items()}, body=b"".join(chunks))
    except httpx.HTTPError as e:
        raise KpError("UPSTREAM_UNAVAILABLE", "HTTP fetch failed", {"url": url}) from e


_transport: Transport = _httpx_transport


def set_transport_for_testing(t: Transport | None) -> None:
    global _transport
    _transport = t or _httpx_transport
    clear_robots_cache()


@dataclass
class _Robots:
    fetched: float
    parser: urllib.robotparser.RobotFileParser | None  # None = allow all
    deny_all: bool = False


_robots: dict[str, _Robots] = {}
_last_hit: dict[str, float] = {}
_lock = threading.Lock()


def clear_robots_cache() -> None:
    with _lock:
        _robots.clear()
        _last_hit.clear()


def _origin(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise KpError("VALIDATION", "Only absolute http(s) URLs can be fetched", {"url": url})
    netloc = parts.hostname + (f":{parts.port}" if parts.port else "")
    return f"{parts.scheme}://{netloc}", parts.hostname


def _load_robots(origin: str) -> _Robots:
    now = time.monotonic()
    with _lock:
        hit = _robots.get(origin)
        if hit is not None and now - hit.fetched < ROBOTS_TTL_S:
            return hit
    try:
        resp = _transport("GET", origin + "/robots.txt", {"user-agent": user_agent()}, DEFAULT_TIMEOUT_S)
        if 200 <= resp.status < 300:
            parser = urllib.robotparser.RobotFileParser()
            parser.parse(resp.body.decode("utf-8", errors="replace").splitlines())
            entry = _Robots(fetched=now, parser=parser)
        elif 400 <= resp.status < 500:
            entry = _Robots(fetched=now, parser=None)  # no robots.txt: everything allowed
        else:
            # 3xx (not followed) and 5xx: treat as a temporary full disallow, re-check soon.
            entry = _Robots(fetched=now - ROBOTS_TTL_S + 600, parser=None, deny_all=True)
    except KpError:
        entry = _Robots(fetched=now - ROBOTS_TTL_S + 600, parser=None, deny_all=True)
    with _lock:
        _robots[origin] = entry
    return entry


def robots_allows(url: str) -> bool:
    origin, _ = _origin(url)
    r = _load_robots(origin)
    if r.deny_all:
        return False
    if r.parser is None:
        return True
    return r.parser.can_fetch(PRODUCT_NAME, url)


def _respect_crawl_delay(origin: str) -> None:
    r = _robots.get(origin)
    delay = None
    if r is not None and r.parser is not None:
        d = r.parser.crawl_delay(PRODUCT_NAME)
        delay = float(d) if d is not None else None
    if not delay:
        return
    delay = min(delay, MAX_CRAWL_DELAY_S)
    with _lock:
        last = _last_hit.get(origin, 0.0)
        wait = last + delay - time.monotonic()
        _last_hit[origin] = max(time.monotonic(), last + delay)
    if wait > 0:
        time.sleep(wait)


def http_fetch(
    url: str,
    *,
    method: str = "GET",
    headers: Mapping[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT_S,
    on_skip: Callable[[str], Any] | None = None,
) -> HttpResponse:
    """Fetches ``url`` politely. Raises ProhibitedHost, RobotsDisallowed or KpError(UPSTREAM_UNAVAILABLE).

    ``on_skip`` is called with the URL before RobotsDisallowed / ProhibitedHost is raised; the
    connector base uses it to count the URL in ``RunStats.skipped``.
    """
    origin, host = _origin(url)
    if is_prohibited_host(host):
        if on_skip is not None:
            on_skip(url)
        _log.warning("refused prohibited host", extra={"url": url, "host": host})
        raise ProhibitedHost(url, host)
    if not robots_allows(url):
        if on_skip is not None:
            on_skip(url)
        _log.info("robots.txt disallows url", extra={"url": url})
        raise RobotsDisallowed(url)
    _respect_crawl_delay(origin)
    hdrs = {k.lower(): v for k, v in (headers or {}).items()}
    hdrs["user-agent"] = user_agent()  # always identify ourselves; callers cannot override
    hdrs.setdefault("from", os.environ.get("KP_CRAWLER_CONTACT_EMAIL", "") or "")
    if not hdrs["from"]:
        del hdrs["from"]
    return _transport(method.upper(), url, hdrs, timeout)
