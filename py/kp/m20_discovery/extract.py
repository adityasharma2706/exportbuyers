"""M20 step 4: LLM extraction (tier ``classify``, JSON) and snippet verification.

The LLM only *points at* text. Every snippet must be an exact substring of the fetched page text
of the URL it cites (and at most 300 characters); anything else is dropped. The company name and
city are kept only when they, too, appear on the crawled pages. A site with no verified snippet is
discarded. The LLM is never the source of a fact.
"""
from __future__ import annotations

from typing import Any, Callable

from kp.m01_platform import get_logger
from kp.m03_llm import LlmRequest, complete

from .models import (
    DISCOVERY_V,
    SNIPPET_MAX_CHARS,
    CrawledPage,
    Extraction,
    VerifiedSnippet,
)

_log = get_logger("kp.m20_discovery.extract")

PURPOSE = "m20.discovery.extract"

SYSTEM_PROMPT = (
    "You review pages from one company website. Decide whether this company buys (imports, distributes, "
    "wholesales, retails or uses as an input) the product described. Answer only from the page text given. "
    "Quote evidence as snippets copied EXACTLY, character for character, from the page text (no paraphrase, "
    "no ellipsis, at most 300 characters each), with the URL of the page the snippet is on. If the pages do "
    "not show that the company deals in this product, set is_buyer_of_product to false and return no "
    "snippets. company_name and city must be copied from the page text, or null. country is the ISO 3166-1 "
    "alpha-2 code of the country the company is based in, or null if the pages do not say."
)

JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["is_buyer_of_product", "confidence", "snippets", "company_name", "city", "country"],
    "properties": {
        "is_buyer_of_product": {"type": "boolean"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "snippets": {
            "type": "array",
            "maxItems": 5,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["text", "url"],
                "properties": {"text": {"type": "string", "maxLength": 300}, "url": {"type": "string"}},
            },
        },
        "company_name": {"type": ["string", "null"]},
        "city": {"type": ["string", "null"]},
        "country": {"type": ["string", "null"]},
    },
}

# (system, user_message) -> parsed JSON. Replaceable for tests.
LlmJsonFn = Callable[[str, str], Any]


def _default_llm(system: str, user: str) -> Any:
    res = complete(LlmRequest(
        tier="classify",
        purpose=PURPOSE,
        system=system,
        messages=[{"role": "user", "content": user}],
        # Crawled pages can carry business contact details, so the prompt is not declared PII-free
        # (M03 then logs only hashes of it).
        pii_free=False,
        json_schema=JSON_SCHEMA,
        temperature=0.0,
        cacheable=True,
        job_type="m20.discover",
    ))
    return res.json


def build_prompt(heading: str, product_terms: list[str], pages: list[CrawledPage], *,
                 max_page_chars: int, max_total_chars: int) -> str:
    lines = [
        f"Product: HS heading {heading} — {'; '.join(product_terms) or 'see heading'}",
        f"Evaluation version: {DISCOVERY_V}",
        "",
        "Pages:",
    ]
    budget = max_total_chars
    for p in pages:
        if budget <= 0:
            break
        chunk = p.text[: min(max_page_chars, budget)]
        budget -= len(chunk)
        lines += [f"=== URL: {p.url}", f"Title: {p.title}", chunk, "=== END", ""]
    return "\n".join(lines)


def _norm_url(u: str) -> str:
    return u.strip().rstrip("/").lower()


def verify_snippets(ex: Extraction, pages: list[CrawledPage]) -> tuple[list[VerifiedSnippet], int]:
    """(verified snippets, number dropped). A snippet survives only if its text is an exact substring
    of the fetched text of the page it cites (≤ 300 chars, not blank). Duplicates are removed."""
    by_url = {_norm_url(p.url): p for p in pages}
    out: list[VerifiedSnippet] = []
    seen: set[str] = set()
    dropped = 0
    for s in ex.snippets:
        text = s.text
        page = by_url.get(_norm_url(s.url))
        if (page is None or not text or not text.strip() or len(text) > SNIPPET_MAX_CHARS
                or text not in page.text):
            dropped += 1
            continue
        if text in seen:
            continue
        seen.add(text)
        out.append(VerifiedSnippet(text=text, url=page.url, captured_at=page.fetched_at,
                                   raw_object_id=page.raw_object_id))
    return out, dropped


def grounded(value: str | None, pages: list[CrawledPage], *, max_len: int = 300) -> str | None:
    """``value`` if it appears (case-insensitively) on one of the pages, else None."""
    if not value:
        return None
    v = " ".join(value.split())
    if not v or len(v) > max_len:
        return None
    folded = v.casefold()
    for p in pages:
        if folded in p.text.casefold() or folded in p.title.casefold() or \
                (p.site_name and folded in p.site_name.casefold()):
            return v
    return None


def fallback_name(pages: list[CrawledPage], domain: str) -> str:
    """A name taken from the site itself: og:site_name, else the homepage title's first segment,
    else the domain."""
    for p in pages:
        if p.site_name:
            return p.site_name
    if pages and pages[0].title:
        for sep in (" | ", " – ", " - ", " — ", " :: "):
            if sep in pages[0].title:
                head = pages[0].title.split(sep)[0].strip()
                if head:
                    return head[:300]
        return pages[0].title[:300]
    return domain


def extract(heading: str, product_terms: list[str], pages: list[CrawledPage], *, max_page_chars: int,
            max_total_chars: int, llm: LlmJsonFn | None = None) -> Extraction:
    """Runs the LLM over the pages. Raises the M03 errors (UPSTREAM_UNAVAILABLE, LLM_BAD_OUTPUT)."""
    prompt = build_prompt(heading, product_terms, pages, max_page_chars=max_page_chars,
                          max_total_chars=max_total_chars)
    raw = (llm or _default_llm)(SYSTEM_PROMPT, prompt)
    ex = Extraction.model_validate(raw)
    _log.info("extraction done", extra={"heading": heading, "is_buyer": ex.is_buyer_of_product,
                                        "snippets": len(ex.snippets), "pages": len(pages)})
    return ex
