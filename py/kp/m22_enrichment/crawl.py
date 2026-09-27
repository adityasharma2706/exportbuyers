"""M22 step 2: crawl the company's contact and about pages.

Reuses M20's ``WebCrawlConnector`` (source ``web.crawl``: robots-aware ``http_fetch``, same-site
redirects, 1 request/second per domain, raw landing through M08). The page selection differs from
discovery: after the homepage, up to ``MAX_CONTACT_PAGES`` same-site links whose path looks like a
contact, about or legal-notice page, in several languages (legal notices such as the German
*Impressum* are where many companies publish their phone and address).
"""
from __future__ import annotations

import re
from typing import Iterable
from urllib.parse import urlsplit

from kp.m01_platform import KpError, get_logger
from kp.m08_sources import RawItem
from kp.m20_discovery import WebCrawlConnector, html_to_text

from .extract import absolute, same_site_url
from .models import ContactPage

_log = get_logger("kp.m22_enrichment.crawl")

MAX_CONTACT_PAGES = 4        # besides the homepage [tunable]

# Ordered by priority: a contact page first, then legal notice, then about.
CONTACT_PATH_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("contact", re.compile(r"contact|kontakt|contacto|contato|contatti|contatto|iletisim|enquir|get-in-touch",
                           re.IGNORECASE)),
    ("legal", re.compile(r"impressum|imprint|legal-notice|mentions-legales|aviso-legal|colofon", re.IGNORECASE)),
    ("about", re.compile(r"about|ueber-uns|uber-uns|qui-sommes|quienes-somos|chi-siamo|over-ons|hakkimizda|"
                         r"company-profile|empresa|unternehmen", re.IGNORECASE)),
)
_SKIP_EXT = re.compile(r"\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mp3|css|js)$", re.IGNORECASE)


def contact_links(base_url: str, hrefs: Iterable[str], domain: str, limit: int = MAX_CONTACT_PAGES) -> list[str]:
    """Up to ``limit`` same-site contact/legal/about URLs, one per category first, then the rest."""
    buckets: dict[str, list[str]] = {name: [] for name, _ in CONTACT_PATH_PATTERNS}
    seen: set[str] = {base_url.rstrip("/")}
    for href in hrefs:
        h = href.strip()
        if not h or h.startswith(("mailto:", "tel:", "javascript:", "#", "data:", "callto:", "whatsapp:")):
            continue
        try:
            url = absolute(base_url, h)
            parts = urlsplit(url)
        except ValueError:
            continue
        if parts.scheme not in ("http", "https") or not same_site_url(url, domain):
            continue
        path = parts.path or "/"
        if _SKIP_EXT.search(path) or url.rstrip("/") in seen:
            continue
        for name, pat in CONTACT_PATH_PATTERNS:
            if pat.search(path):
                seen.add(url.rstrip("/"))
                buckets[name].append(url)
                break
    out: list[str] = []
    depth = 0
    while len(out) < limit and any(len(v) > depth for v in buckets.values()):
        for name, _ in CONTACT_PATH_PATTERNS:
            if len(buckets[name]) > depth and len(out) < limit:
                out.append(buckets[name][depth])
        depth += 1
    return out


class ContactCrawler(WebCrawlConnector):
    """The ``web.crawl`` connector with a contact-focused page selection; keeps the raw HTML."""

    def __init__(self, *, max_contact_pages: int = MAX_CONTACT_PAGES, **kwargs) -> None:  # type: ignore[no-untyped-def]
        super().__init__(**kwargs)
        self._max_contact = max(0, min(max_contact_pages, 8))

    def crawl_contacts(self, homepage: str, domain: str) -> list[ContactPage]:
        """Homepage + contact/about pages, each landed (or referenced in memory when the source may
        not be stored). Failed pages are skipped; an upstream outage returns what was fetched."""
        pages: list[ContactPage] = []
        seen_sha: set[str] = set()

        def keep(item: RawItem, html: str, url: str) -> None:
            if item.sha256 in seen_sha:
                return
            seen_sha.add(item.sha256)
            ref = self.land(item) if self.source.can_store else self.in_memory_ref(item)
            pages.append(ContactPage(url=item.url or url, html=html, fetched_at=ref.fetched_at,
                                     raw_object_id=ref.raw_object_id, sha256=ref.sha256))

        try:
            first = self._page_item(homepage, domain)
            if first is None:
                return pages
            keep(first[0], first[1], homepage)
            _t, _ti, _s, hrefs = html_to_text(first[1])
            base = first[0].url or homepage
            for link in contact_links(base, hrefs, domain, self._max_contact):
                page = self._page_item(link, domain)
                if page is not None:
                    keep(page[0], page[1], link)
        except KpError as e:
            if e.code not in ("UPSTREAM_UNAVAILABLE", "VALIDATION"):
                raise
            _log.info("contact crawl stopped early", extra={"homepage": homepage, "code": e.code, "pages": len(pages)})
        return pages
