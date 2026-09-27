"""M20 search vendor adapter (``SearchApi``, rate class ``search_api``).

The discovery pipeline depends only on the ``SearchApi`` protocol. The production adapter is
``BraveSearchApi`` [assumption: vendor choice — any web-search API returning URL/title/snippet fits
the protocol]. Every call checks the vendor budget flag and records its cost (M01).

An outage (network error, HTTP 429/5xx, budget flag set) raises ``SearchUnavailable`` so the job
can retry with backoff and, after 3 attempts, complete degraded.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Any, Callable, Mapping, Protocol

from kp.m01_platform import KpError, assert_vendor_budget, get_logger, get_secret, record_cost

from .models import SEARCH_VENDOR, SearchQuery, SearchResult

_log = get_logger("kp.m20_discovery.search")

BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
BRAVE_PAGE_SIZE = 20
BRAVE_MAX_OFFSET = 9
# Country codes the vendor accepts for result localisation; others search with country=ALL.
BRAVE_COUNTRIES = frozenset({
    "AR", "AU", "AT", "BE", "BR", "CA", "CL", "DK", "FI", "FR", "DE", "HK", "IN", "ID", "IT", "JP", "KR", "MY",
    "MX", "NL", "NZ", "NO", "CN", "PL", "PT", "PH", "RU", "SA", "ZA", "ES", "SE", "CH", "TW", "TR", "GB", "US",
})
DEFAULT_COST_MICROS_INR = 420_000   # ≈ USD 0.005 per request [tunable]
DEFAULT_TIMEOUT_S = 15.0
MIN_INTERVAL_S = 1.0                # in-process pacing, on top of the M02 rate class [tunable]


class SearchUnavailable(KpError):
    """The search API is down, throttling us, or its budget is exhausted. Retry later."""

    def __init__(self, message: str, details: Mapping[str, Any] | None = None) -> None:
        super().__init__("UPSTREAM_UNAVAILABLE", message, {"vendor": SEARCH_VENDOR, **(details or {})})


class SearchApi(Protocol):
    def search(self, q: SearchQuery, *, max_results: int) -> list[SearchResult]: ...


# (url, params, headers, timeout) -> (status, json body or None)
HttpGet = Callable[[str, Mapping[str, str], Mapping[str, str], float], tuple[int, Any]]


def _httpx_get(url: str, params: Mapping[str, str], headers: Mapping[str, str], timeout: float) -> tuple[int, Any]:
    import httpx

    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            r = client.get(url, params=dict(params), headers=dict(headers))
    except httpx.HTTPError as e:
        raise SearchUnavailable("Search API request failed", {"error": type(e).__name__}) from e
    body: Any = None
    if r.status_code == 200:
        try:
            body = r.json()
        except ValueError as e:
            raise SearchUnavailable("Search API returned a non-JSON body") from e
    return r.status_code, body


class BraveSearchApi:
    """Brave Web Search API adapter. At most 30 results per query (two pages of 20, trimmed)."""

    def __init__(self, *, api_key: str | None = None, http_get: HttpGet | None = None,
                 cost_micros_inr: int | None = None, sleep: Callable[[float], None] = time.sleep,
                 min_interval_s: float = MIN_INTERVAL_S) -> None:
        self._api_key = api_key
        self._get = http_get or _httpx_get
        env_cost = os.environ.get("SEARCH_API_COST_MICROS_INR")
        self._cost = cost_micros_inr if cost_micros_inr is not None else (
            int(env_cost) if env_cost and env_cost.isdigit() else DEFAULT_COST_MICROS_INR)
        self._sleep = sleep
        self._interval = min_interval_s
        self._last = 0.0
        self._lock = threading.Lock()

    def _key(self) -> str:
        if self._api_key is None:
            self._api_key = get_secret("SEARCH_API_KEY")
        return self._api_key

    def _pace(self) -> None:
        with self._lock:
            wait = self._last + self._interval - time.monotonic()
            self._last = max(time.monotonic(), self._last + self._interval)
        if wait > 0:
            self._sleep(wait)

    def _page(self, q: SearchQuery, offset: int, count: int) -> list[dict[str, Any]]:
        try:
            assert_vendor_budget(SEARCH_VENDOR)
        except KpError as e:
            raise SearchUnavailable("Search API budget is exhausted", {"reason": "budget_exceeded"}) from e
        self._pace()
        params = {
            "q": q.text,
            "count": str(count),
            "offset": str(offset),
            "country": q.country if q.country in BRAVE_COUNTRIES else "ALL",
            "search_lang": q.language,
            "safesearch": "moderate",
            "text_decorations": "false",
        }
        headers = {"accept": "application/json", "x-subscription-token": self._key()}
        status, body = self._get(BRAVE_ENDPOINT, params, headers, DEFAULT_TIMEOUT_S)
        record_cost(vendor=SEARCH_VENDOR, op="search", units=1, cost_micros_inr=self._cost, job_type="m20.discover")
        if status == 429 or status >= 500:
            raise SearchUnavailable(f"Search API returned HTTP {status}", {"status": status})
        if status != 200:
            raise KpError("INTERNAL", f"Search API rejected the request (HTTP {status})",
                          {"vendor": SEARCH_VENDOR, "status": status})
        web = body.get("web") if isinstance(body, Mapping) else None
        results = web.get("results") if isinstance(web, Mapping) else None
        return [r for r in results or [] if isinstance(r, Mapping)]

    def search(self, q: SearchQuery, *, max_results: int) -> list[SearchResult]:
        limit = max(1, min(int(max_results), 30))
        out: list[SearchResult] = []
        offset = 0
        while len(out) < limit and offset <= BRAVE_MAX_OFFSET:
            page = self._page(q, offset, BRAVE_PAGE_SIZE)
            for r in page:
                url = r.get("url")
                if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                    continue
                out.append(SearchResult(url=url, title=str(r.get("title") or "")[:500],
                                        description=str(r.get("description") or "")[:1000],
                                        rank=len(out) + 1, query=q.text))
                if len(out) >= limit:
                    break
            if len(page) < BRAVE_PAGE_SIZE:
                break
            offset += 1
        _log.info("search query done", extra={"query": q.text, "language": q.language, "results": len(out)})
        return out


_default: SearchApi | None = None
_default_lock = threading.Lock()


def default_search_api() -> SearchApi:
    global _default
    with _default_lock:
        if _default is None:
            _default = BraveSearchApi()
        return _default


def set_search_api_for_testing(api: SearchApi | None) -> None:
    global _default
    with _default_lock:
        _default = api
