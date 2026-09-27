"""M20 Web discovery path — Python public API.

REQ-015 (find buyers for a product × country), REQ-016 (buyers of *this* product, with evidence),
REQ-017 and REQ-024 (every web fact points to the page URL and capture date, with source type and
confidence).

- IF-20a job ``m20.discover {hsHeading, country, reason: 'prewarm'|'on_demand', requestedBy?}``,
  idempotency key ``disc:<heading>:<country>:<yyyy-mm-dd>``; ``request_discovery`` enqueues it.
- Pipeline: search API → block list / IF-10c → robots-aware crawl + ``land()`` (M08) → LLM
  extraction with exact-substring snippet verification → ``resolve()`` (M18) →
  ``write_assertion(product_evidence, llm_assisted=True)`` (M09) → ``classify()`` (M19).
- EV-05 ``discovery.completed {country, hsHeading, newCompanies, runId, degraded}`` at the end.
- Weekly pre-warm (``/config/prewarm.yaml``); served only for countries in
  ``/config/discovery_released.yaml`` (``is_country_released``).

Other modules import only from here.
"""
from .config import (
    DiscoveryConfig,
    PrewarmPlan,
    ReleasedCountries,
    get_discovery_config,
    get_prewarm_plan,
    get_released_countries,
    is_country_released,
    parse_discovery_config,
    parse_prewarm,
    parse_released,
    set_config_for_testing,
)
from .crawl import DomainThrottle, WebCrawlConnector, html_to_text, internal_links
from .extract import JSON_SCHEMA, SYSTEM_PROMPT, build_prompt, extract, grounded, verify_snippets
from .jobs import (
    DiscoveryCompleted,
    completion_payload,
    handle_discover,
    handle_prewarm,
    register_discovery_jobs,
    request_discovery,
    reset_registration_for_testing,
    set_conn_factory_for_testing,
    set_deps_for_testing,
)
from .models import (
    DEGRADE_AFTER_ATTEMPTS,
    DISCOVER_JOB,
    DISCOVERY_V,
    EV_DISCOVERY_COMPLETED,
    PREWARM_JOB,
    PRODUCER,
    PRODUCER_VERSION,
    SEARCH_RATE_CLASS,
    WEB_SOURCE_ID,
    CandidateSite,
    CrawledPage,
    DiscoverPayload,
    DiscoveryRun,
    Extraction,
    SearchQuery,
    SearchResult,
    SiteResult,
    VerifiedSnippet,
    idempotency_key,
)
from .pipeline import DiscoveryDeps, build_queries, candidate_sites, product_terms, run_discovery, short_term
from .search import BraveSearchApi, SearchApi, SearchUnavailable, default_search_api, set_search_api_for_testing

__all__ = [
    "DEGRADE_AFTER_ATTEMPTS",
    "DISCOVERY_V",
    "DISCOVER_JOB",
    "EV_DISCOVERY_COMPLETED",
    "JSON_SCHEMA",
    "PREWARM_JOB",
    "PRODUCER",
    "PRODUCER_VERSION",
    "SEARCH_RATE_CLASS",
    "SYSTEM_PROMPT",
    "WEB_SOURCE_ID",
    "BraveSearchApi",
    "CandidateSite",
    "CrawledPage",
    "DiscoverPayload",
    "DiscoveryCompleted",
    "DiscoveryConfig",
    "DiscoveryDeps",
    "DiscoveryRun",
    "DomainThrottle",
    "Extraction",
    "PrewarmPlan",
    "ReleasedCountries",
    "SearchApi",
    "SearchQuery",
    "SearchResult",
    "SearchUnavailable",
    "SiteResult",
    "VerifiedSnippet",
    "WebCrawlConnector",
    "build_prompt",
    "build_queries",
    "candidate_sites",
    "completion_payload",
    "default_search_api",
    "extract",
    "get_discovery_config",
    "get_prewarm_plan",
    "get_released_countries",
    "grounded",
    "handle_discover",
    "handle_prewarm",
    "html_to_text",
    "idempotency_key",
    "internal_links",
    "is_country_released",
    "parse_discovery_config",
    "parse_prewarm",
    "parse_released",
    "product_terms",
    "register_discovery_jobs",
    "request_discovery",
    "reset_registration_for_testing",
    "run_discovery",
    "set_config_for_testing",
    "set_conn_factory_for_testing",
    "set_deps_for_testing",
    "set_search_api_for_testing",
    "short_term",
    "verify_snippets",
]
