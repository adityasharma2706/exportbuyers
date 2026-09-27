"""M20 web discovery pipeline (LLD M20 steps 1–5) for one ``(hs_heading, country)`` cell.

1. Queries from the heading description plus synonyms: 3 templates × each of the country's languages;
   at most 30 results per query from the ``SearchApi``.
2. Marketplaces, social sites and news are dropped (``/config/discovery.yaml``), as are prohibited
   hosts and suppressed domains (IF-10c).
3. Each site is crawled through M08 (robots-aware, 1 req/s per domain) and landed.
4. LLM extraction; snippets must be exact substrings of the fetched page text or they are dropped.
5. ``resolve()`` (M18) → ``write_assertion(product_evidence)`` (M09, ``llm_assisted=True``, pointing
   at the URL, capture date and raw object) → ``classify()`` (M19) over that evidence.

Step 6 (EV-05) is emitted by the job handler in ``jobs.py``.
"""
from __future__ import annotations

import re
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol
from urllib.parse import urlsplit

from kp.m01_platform import KpError, get_logger, get_secret, new_id, span
from kp.m08_sources import is_prohibited_host
from kp.m09_evidence import AssertionIn, open_repo, write_assertion
from kp.m10_policy import is_suppressed as policy_is_suppressed
from kp.m18_resolution import Candidate, is_excluded_anchor_domain, normalise_domain, resolve
from kp.m19_classifiers import EvidenceText, classify

from .config import DiscoveryConfig, get_discovery_config
from .crawl import WebCrawlConnector
from .extract import LlmJsonFn, extract, fallback_name, grounded, verify_snippets
from .models import (
    DISCOVERY_V,
    PRODUCER,
    PRODUCER_VERSION,
    WEB_SOURCE_ID,
    CandidateSite,
    CrawledPage,
    DiscoverPayload,
    DiscoveryRun,
    SearchQuery,
    SearchResult,
    SiteResult,
)
from .search import SearchApi, SearchUnavailable, default_search_api

_log = get_logger("kp.m20_discovery.pipeline")

_PAREN = re.compile(r"\([^)]*\)")
_CC_RE = re.compile(r"^[A-Z]{2}$")
MAX_TERM_CHARS = 80


# ---- dependencies ----------------------------------------------------------------------------------

class SiteCrawler(Protocol):
    def crawl_site(self, homepage: str) -> list[CrawledPage]: ...


HeadingText = Callable[[str], "str | None"]
TxFactory = Callable[[], AbstractContextManager[Any]]


def pg_heading_text(heading: str) -> str | None:
    """The current nomenclature's plain-English description of a 4-digit heading (M12 table)."""
    import psycopg

    with psycopg.connect(get_secret("DATABASE_URL")) as conn:
        row = conn.execute(
            "select coalesce(c.description_en_simple, c.description) from knowledge.hs_code c "
            "join knowledge.hs_version v on v.version = c.version "
            "where v.is_current and c.level = 'heading' and c.code = %s "
            "order by v.loaded_at desc limit 1",
            (heading,),
        ).fetchone()
    return str(row[0]) if row and row[0] else None


@dataclass
class DiscoveryDeps:
    search: SearchApi | None = None
    crawler: Callable[[], SiteCrawler] | None = None
    llm: LlmJsonFn | None = None
    tx: TxFactory | None = None
    heading_text: HeadingText | None = None
    is_suppressed: Callable[[str, str], bool] | None = None
    config: DiscoveryConfig | None = None
    classify_llm: Any = None            # passed through to M19 classify(llm=...) (tests)
    extra: dict[str, Any] = field(default_factory=dict)

    def get_search(self) -> SearchApi:
        return self.search or default_search_api()

    def get_crawler(self, cfg: DiscoveryConfig) -> SiteCrawler:
        if self.crawler is not None:
            return self.crawler()
        return WebCrawlConnector(max_internal_pages=cfg.max_internal_pages)

    def open_tx(self) -> AbstractContextManager[Any]:
        return self.tx() if self.tx is not None else open_repo()

    def get_heading_text(self, heading: str) -> str | None:
        return (self.heading_text or pg_heading_text)(heading)

    def suppressed(self, kind: str, raw: str) -> bool:
        return (self.is_suppressed or policy_is_suppressed)(kind, raw)

    def get_config(self) -> DiscoveryConfig:
        return self.config or get_discovery_config()


# ---- step 1: queries ------------------------------------------------------------------------------

def short_term(description: str) -> str:
    """A searchable phrase from an HS description: no parentheticals, first clause, ≤ 80 chars."""
    s = _PAREN.sub(" ", description)
    s = re.split(r"[;:]", s, maxsplit=1)[0]
    s = " ".join(s.split()).strip(" ,.-")
    if len(s) > MAX_TERM_CHARS:
        cut = s[:MAX_TERM_CHARS]
        s = cut.rsplit(",", 1)[0] if "," in cut else cut.rsplit(" ", 1)[0]
    return s.strip(" ,.-")


def product_terms(heading: str, description: str | None, cfg: DiscoveryConfig, lang: str) -> list[str]:
    terms: list[str] = list(cfg.synonyms_for(heading, lang))
    base = short_term(description) if description else ""
    if lang == "en":
        terms = ([base] if base else []) + [t for t in terms if t.casefold() != base.casefold()]
    elif not terms:
        # No local-language synonym: fall back to the English description and synonyms.
        terms = ([base] if base else []) + list(cfg.synonyms_for(heading, "en"))
    return [t for t in dict.fromkeys(terms) if t]


def build_queries(heading: str, country: str, description: str | None, cfg: DiscoveryConfig) -> list[SearchQuery]:
    """3 query templates × each of the country's languages; template i uses term i (cycled)."""
    out: list[SearchQuery] = []
    seen: set[str] = set()
    for lang in cfg.languages_for(country):
        terms = product_terms(heading, description, cfg, lang)
        if not terms:
            continue
        name = cfg.country_name(country, lang)
        for i, tpl in enumerate(cfg.query_templates.get(lang, ())):
            text = " ".join(tpl.format(term=terms[i % len(terms)], country=name).split())
            if text.casefold() in seen:
                continue
            seen.add(text.casefold())
            out.append(SearchQuery(text=text, language=lang, country=country))
    return out


# ---- step 2: candidate sites ----------------------------------------------------------------------

def _host(url: str) -> str | None:
    try:
        return urlsplit(url).hostname
    except ValueError:
        return None


def candidate_sites(results: list[SearchResult], cfg: DiscoveryConfig, run: DiscoveryRun,
                    suppressed: Callable[[str, str], bool]) -> list[CandidateSite]:
    """One site per registrable domain, in rank order, after the block list and IF-10c."""
    sites: dict[str, CandidateSite] = {}
    rejected: set[str] = set()
    for r in results:
        host = _host(r.url)
        if not host:
            continue
        domain = normalise_domain(host)
        if not domain or domain in sites or domain in rejected:
            continue
        run.domains_considered += 1
        if cfg.is_blocked(domain) or is_prohibited_host(host) or is_excluded_anchor_domain(domain):
            run.domains_blocked += 1
            rejected.add(domain)
            continue
        try:
            is_supp = suppressed("domain", domain)
        except KpError:
            is_supp = True  # an identifier we cannot normalise is not worth the risk
        if is_supp:
            run.domains_suppressed += 1
            rejected.add(domain)
            continue
        scheme = urlsplit(r.url).scheme or "https"
        sites[domain] = CandidateSite(domain=domain, homepage=f"{scheme}://{host}/", first_result=r)
        if len(sites) >= cfg.max_domains_per_run:
            break
    return list(sites.values())


# ---- step 5: resolve, write, classify -------------------------------------------------------------

def _country_of(ex_country: str | None, run_country: str, pages: list[CrawledPage]) -> str:
    """The run's country unless the LLM names another one that the pages themselves mention."""
    cc = (ex_country or "").strip().upper()
    if not _CC_RE.match(cc) or cc == run_country:
        return run_country
    try:
        import pycountry

        entry = pycountry.countries.get(alpha_2=cc)
    except (ImportError, LookupError, KeyError):
        entry = None
    if entry is None:
        return run_country
    names = [getattr(entry, "name", None), getattr(entry, "common_name", None), getattr(entry, "official_name", None)]
    return cc if any(grounded(n, pages) for n in names if n) else run_country


def _write_site(site: CandidateSite, pages: list[CrawledPage], payload: DiscoverPayload, run: DiscoveryRun,
                deps: DiscoveryDeps, cfg: DiscoveryConfig, terms: list[str]) -> SiteResult:
    ex = extract(payload.hs_heading, terms, pages, max_page_chars=cfg.max_page_chars_for_llm,
                 max_total_chars=cfg.max_total_chars_for_llm, llm=deps.llm)
    if not ex.is_buyer_of_product:
        return SiteResult(domain=site.domain, outcome="not_buyer")
    snippets, dropped = verify_snippets(ex, pages)
    if not snippets:
        return SiteResult(domain=site.domain, outcome="no_valid_snippets", snippets_dropped=dropped)

    country = _country_of(ex.country, run.country, pages)
    name = grounded(ex.company_name, pages) or fallback_name(pages, site.domain)
    city = grounded(ex.city, pages, max_len=200)
    primary, rest = snippets[0], snippets[1:]
    captured_at = primary.captured_at.isoformat()

    with deps.open_tx() as tx:
        res = resolve(Candidate(name=name[:500], country=country, city=city, domain=site.domain,
                                source_id=WEB_SOURCE_ID), tx=tx)
        if res.company_id is None:
            return SiteResult(domain=site.domain, outcome="suppressed", snippets_dropped=dropped, country=country)
        company_id = str(res.company_id)
        source_ref: dict[str, Any] = {
            "url": primary.url,
            "captured_at": captured_at,
            "raw_object_id": primary.raw_object_id,
            "run_id": run.run_id,
            "discovery_v": DISCOVERY_V,
            "search_query": site.first_result.query,
            "search_rank": site.first_result.rank,
            # Further verified snippets for the same heading; each keeps its own page reference.
            "additional_snippets": [
                {"text": s.text, "url": s.url, "captured_at": s.captured_at.isoformat(),
                 "raw_object_id": s.raw_object_id} for s in rest
            ],
        }
        aid = write_assertion(AssertionIn(
            subject_id=company_id,
            attribute="product_evidence",
            value={"hs_heading": payload.hs_heading, "snippet": primary.text, "url": primary.url},
            source_id=WEB_SOURCE_ID,
            source_ref=source_ref,
            observed_at=primary.captured_at,
            checked_at=primary.captured_at,
            confidence=round(float(ex.confidence), 4),
            region=country,
            producer=PRODUCER,
            producer_version=PRODUCER_VERSION,
            llm_assisted=True,
        ), tx=tx)
        if aid is None:  # an identifier in the value is suppressed (M09 step 5)
            return SiteResult(domain=site.domain, outcome="suppressed", company_id=company_id,
                              snippets_dropped=dropped, country=country)
        classify(company_id, [EvidenceText(assertion_id=aid, text=primary.text, url=primary.url,
                                           captured_at=primary.captured_at, hs_heading=payload.hs_heading)],
                 tx=tx, llm=deps.classify_llm, job_type="m20.discover")
    return SiteResult(domain=site.domain, outcome="written", company_id=company_id, created=res.created,
                      evidence_assertion_id=str(aid), snippets_dropped=dropped, country=country)


# ---- the run --------------------------------------------------------------------------------------

def _search_all(queries: list[SearchQuery], api: SearchApi, cfg: DiscoveryConfig, run: DiscoveryRun) -> list[SearchResult]:
    results: list[SearchResult] = []
    last_err: KpError | None = None
    for q in queries:
        run.queries += 1
        try:
            results.extend(api.search(q, max_results=cfg.max_results_per_query))
        except SearchUnavailable as e:
            run.queries_failed += 1
            last_err = e
            _log.warning("search query failed", extra={"query": q.text, "err": e.message})
    if queries and run.queries_failed == len(queries):
        assert last_err is not None
        raise last_err
    run.results = len(results)
    return results


def run_discovery(payload: DiscoverPayload, deps: DiscoveryDeps | None = None, *,
                  run_id: str | None = None) -> DiscoveryRun:
    """Steps 1–5 for one cell. Raises ``SearchUnavailable`` when every search query failed, and
    ``KpError('UPSTREAM_UNAVAILABLE')`` when the LLM was unavailable for every site."""
    d = deps or DiscoveryDeps()
    cfg = d.get_config()
    run = DiscoveryRun(run_id=run_id or new_id(), country=payload.country, hs_heading=payload.hs_heading,
                       reason=payload.reason)
    with span("m20.discover", {"country": payload.country, "hs_heading": payload.hs_heading,
                               "reason": payload.reason, "run_id": run.run_id}):
        description = d.get_heading_text(payload.hs_heading)
        terms = product_terms(payload.hs_heading, description, cfg, "en")
        if payload.domain:
            dom = normalise_domain(payload.domain)
            if not dom:
                raise KpError("VALIDATION", "domain cannot be normalised", {"domain": payload.domain})
            hit = SearchResult(url=f"https://{dom}/", query="recrawl", rank=0)
            sites = candidate_sites([hit], cfg, run, d.suppressed)
        else:
            queries = build_queries(payload.hs_heading, payload.country, description, cfg)
            if not queries:
                raise KpError("VALIDATION", "No description or synonyms for this heading; cannot build queries",
                              {"hs_heading": payload.hs_heading})
            sites = candidate_sites(_search_all(queries, d.get_search(), cfg, run), cfg, run, d.suppressed)

        crawler = d.get_crawler(cfg) if sites else None
        upstream_errors = 0
        for site in sites:
            try:
                assert crawler is not None
                pages = crawler.crawl_site(site.homepage)
                if not pages:
                    run.sites.append(SiteResult(domain=site.domain, outcome="no_pages"))
                    continue
                run.sites.append(_write_site(site, pages, payload, run, d, cfg, terms))
            except KpError as e:
                if e.code == "UPSTREAM_UNAVAILABLE":
                    upstream_errors += 1
                run.sites.append(SiteResult(domain=site.domain, outcome="error", error=f"{e.code}: {e.message}"[:500]))
                _log.warning("site failed", extra={"domain": site.domain, "code": e.code})
            except Exception as e:  # noqa: BLE001 — one bad site must not sink the run
                run.sites.append(SiteResult(domain=site.domain, outcome="error", error=type(e).__name__))
                _log.exception("site failed", extra={"domain": site.domain})
        if sites and upstream_errors == len(sites):
            raise KpError("UPSTREAM_UNAVAILABLE", "The language model was unavailable for every site",
                          {"run_id": run.run_id, "sites": len(sites)})
    _log.info("discovery run finished", extra={"run": run.summary()})
    return run
