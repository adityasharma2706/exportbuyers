"""M20 step 3: crawl a candidate site through M08 (``http_fetch`` robots-aware, ``land()``).

The homepage plus up to 5 internal pages whose path matches
``/products|about|contact|import|brands/`` are fetched, 1 request/second per domain, and every
page body is landed in ``s3://raw/web.crawl/…`` so that each evidence snippet can point to the
exact stored capture (``raw_object_id``) and its capture date.
"""
from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Callable, Iterable, Iterator
from urllib.parse import urldefrag, urljoin, urlsplit

from kp.m01_platform import KpError, get_logger
from kp.m08_sources import (
    Connector,
    FetchRequest,
    HttpResponse,
    ProhibitedHost,
    RawIndex,
    RawItem,
    RawRef,
    RawStore,
    Record,
    RobotsDisallowed,
)
from kp.m18_resolution import normalise_domain

from .models import CRAWL_RATE_CLASS, INTERNAL_PAGE_RE, WEB_SOURCE_ID, CrawledPage

_log = get_logger("kp.m20_discovery.crawl")

PER_DOMAIN_INTERVAL_S = 1.0     # 1 req/s per domain (LLD M20 step 3)
MAX_REDIRECTS = 3
HTML_TYPES = ("text/html", "application/xhtml+xml")
MAX_TEXT_CHARS = 200_000
_WS = re.compile(r"\s+")
_SKIP_TAGS = frozenset({"script", "style", "noscript", "svg", "template", "iframe", "head"})
_BLOCK_TAGS = frozenset({"p", "div", "br", "li", "ul", "ol", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6",
                         "section", "article", "header", "footer", "nav", "table", "dt", "dd", "address"})
_SKIP_EXT = re.compile(r"\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mp3|css|js)$", re.IGNORECASE)


# ---- HTML → text -----------------------------------------------------------------------------------

class _Extractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.links: list[str] = []
        self.title_parts: list[str] = []
        self.site_name: str | None = None
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title":
            self._in_title = True
        if tag in _SKIP_TAGS and tag != "head":
            self._skip += 1
        if tag == "meta" and a.get("property", "").lower() == "og:site_name" and a.get("content"):
            self.site_name = a["content"].strip()[:300] or None
        if tag == "a" and a.get("href"):
            self.links.append(a["href"])
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag in _SKIP_TAGS and tag != "head" and self._skip > 0:
            self._skip -= 1
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data)
            return
        if self._skip == 0:
            self.parts.append(data)


def html_to_text(html: str) -> tuple[str, str, str | None, list[str]]:
    """(visible text with collapsed whitespace, title, og:site_name, raw hrefs)."""
    p = _Extractor()
    try:
        p.feed(html)
        p.close()
    except Exception:  # noqa: BLE001 — malformed HTML: keep whatever was parsed
        _log.info("html parse stopped early")
    lines = (_WS.sub(" ", ln).strip() for ln in "".join(p.parts).split("\n"))
    text = "\n".join(ln for ln in lines if ln)[:MAX_TEXT_CHARS]
    title = _WS.sub(" ", "".join(p.title_parts)).strip()[:300]
    return text, title, p.site_name, p.links


def decode_body(body: bytes, content_type_header: str | None) -> str:
    charset = None
    if content_type_header:
        m = re.search(r"charset=([\w.-]+)", content_type_header, re.IGNORECASE)
        if m:
            charset = m.group(1)
    if charset is None:
        m = re.search(rb"<meta[^>]+charset=[\"']?([\w.-]+)", body[:4096], re.IGNORECASE)
        if m:
            charset = m.group(1).decode("ascii", errors="ignore")
    try:
        return body.decode(charset or "utf-8", errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def same_site(url: str, domain: str) -> bool:
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return False
    return bool(host) and normalise_domain(host) == domain


def internal_links(base_url: str, hrefs: Iterable[str], domain: str, limit: int) -> list[str]:
    """Up to ``limit`` same-site links whose path matches ``/products|about|contact|import|brands/``.

    Links are taken in page order but one per matching keyword first, so a site's many product
    pages do not crowd out its about/contact pages."""
    seen: set[str] = set()
    by_kw: dict[str, list[str]] = {}
    order: list[str] = []
    for href in hrefs:
        href = href.strip()
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "#", "data:")):
            continue
        try:
            absolute = urldefrag(urljoin(base_url, href))[0]
            parts = urlsplit(absolute)
        except ValueError:
            continue
        if parts.scheme not in ("http", "https") or not same_site(absolute, domain):
            continue
        path = parts.path or "/"
        if _SKIP_EXT.search(path):
            continue
        m = INTERNAL_PAGE_RE.search(path)
        if not m or absolute in seen or absolute.rstrip("/") == base_url.rstrip("/"):
            continue
        seen.add(absolute)
        kw = m.group(0).lower()
        if kw not in by_kw:
            order.append(kw)
        by_kw.setdefault(kw, []).append(absolute)
    out: list[str] = []
    depth = 0
    while len(out) < limit and any(len(v) > depth for v in by_kw.values()):
        for kw in order:
            if len(by_kw[kw]) > depth and len(out) < limit:
                out.append(by_kw[kw][depth])
        depth += 1
    return out


# ---- per-domain pacing -----------------------------------------------------------------------------

class DomainThrottle:
    """At most one request per ``interval`` seconds to each registrable domain (process-wide)."""

    def __init__(self, interval: float = PER_DOMAIN_INTERVAL_S, sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._interval = interval
        self._sleep = sleep
        self._clock = clock
        self._next: dict[str, float] = {}
        self._lock = threading.Lock()

    def wait(self, domain: str) -> None:
        with self._lock:
            now = self._clock()
            slot = max(now, self._next.get(domain, 0.0))
            self._next[domain] = slot + self._interval
        if slot > now:
            self._sleep(slot - now)


_throttle = DomainThrottle()


# ---- the connector ---------------------------------------------------------------------------------

class WebCrawlConnector(Connector):
    """``source_id='web.crawl'``. ``fetch`` yields the pages of one site; ``crawl_site`` also lands
    them and returns the parsed pages the discovery pipeline needs."""

    source_id = WEB_SOURCE_ID
    rate_class = CRAWL_RATE_CLASS
    vendor = "web_crawl"

    def __init__(self, *, store: RawStore | None = None, index: RawIndex | None = None,
                 throttle: DomainThrottle | None = None, max_internal_pages: int = 5) -> None:
        super().__init__(store=store, index=index)
        self._throttle = throttle or _throttle
        self._max_internal = max(0, min(max_internal_pages, 5))
        self.skipped: list[str] = []

    # -- M08 contract ----------------------------------------------------------------------------

    def fetch(self, req: FetchRequest) -> Iterable[RawItem]:
        """``req.params = {"url": homepage}`` → the homepage, then its matching internal pages."""
        url = req.params.get("url")
        if not isinstance(url, str) or not url:
            raise KpError("VALIDATION", "web.crawl fetch needs params.url")
        for item, _text in self._crawl_items(url):
            yield item

    def parse(self, ref: RawRef) -> Iterable[Record]:
        """Per-page parsing produces no facts for this source: web facts are written only by the
        discovery pipeline after LLM extraction and exact-substring verification (LLD M20 step 4),
        because the LLM is never the source of a fact."""
        return iter(())

    # -- crawling --------------------------------------------------------------------------------

    def _get(self, url: str, domain: str) -> HttpResponse | None:
        """GET with manual same-site redirects (the M08 helper does not follow them)."""
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            self._throttle.wait(domain)
            try:
                resp = self.http_fetch(current)
            except (RobotsDisallowed, ProhibitedHost):
                self.skipped.append(current)
                return None
            if resp.status in (301, 302, 303, 307, 308):
                loc = resp.headers.get("location")
                if not loc:
                    return None
                nxt = urljoin(current, loc)
                if not same_site(nxt, domain):
                    _log.info("redirect leaves the site; stopped", extra={"from": current, "to": nxt})
                    return None
                current = nxt
                continue
            return resp
        return None

    def _page_item(self, url: str, domain: str) -> tuple[RawItem, str] | None:
        resp = self._get(url, domain)
        if resp is None or resp.status != 200:
            return None
        if resp.content_type not in HTML_TYPES:
            return None
        html = decode_body(resp.body, resp.headers.get("content-type"))
        item = RawItem(body=resp.body, content_type=resp.content_type, url=resp.url or url,
                       fetched_at=datetime.now(timezone.utc), meta={"domain": domain})
        return item, html

    def _crawl_items(self, homepage: str) -> Iterator[tuple[RawItem, str]]:
        host = urlsplit(homepage).hostname or ""
        domain = normalise_domain(host) or host
        first = self._page_item(homepage, domain)
        if first is None:
            return
        yield first
        _text, _title, _site, hrefs = html_to_text(first[1])
        base = first[0].url or homepage
        for link in internal_links(base, hrefs, domain, self._max_internal):
            page = self._page_item(link, domain)
            if page is not None:
                yield page

    def crawl_site(self, homepage: str) -> list[CrawledPage]:
        """Fetches, lands and parses the site's pages. Pages that fail are skipped, not fatal."""
        pages: list[CrawledPage] = []
        seen_sha: set[str] = set()
        try:
            for item, html in self._crawl_items(homepage):
                if item.sha256 in seen_sha:
                    continue
                seen_sha.add(item.sha256)
                ref = self.land(item) if self.source.can_store else self.in_memory_ref(item)
                text, title, site_name, hrefs = html_to_text(html)
                if not text:
                    continue
                pages.append(CrawledPage(
                    url=item.url or homepage, text=text, title=title, site_name=site_name,
                    links=tuple(hrefs[:500]), fetched_at=ref.fetched_at, raw_object_id=ref.raw_object_id,
                    sha256=ref.sha256,
                ))
        except KpError as e:
            if e.code != "UPSTREAM_UNAVAILABLE" and e.code != "VALIDATION":
                raise
            _log.info("site fetch failed; using the pages fetched so far",
                      extra={"homepage": homepage, "code": e.code, "pages": len(pages)})
        return pages
