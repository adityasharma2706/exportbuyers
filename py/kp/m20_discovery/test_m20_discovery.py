"""M20 tests: query building, filtering, snippet verification, the end-to-end write path on the
in-memory evidence store, and the degraded completion after search-API failures."""
from __future__ import annotations

import json
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from typing import Any, Iterator

import pytest
import yaml

from kp.m02_queue import JobMeta
from kp.m03_llm import LlmRequest, LlmResult
from kp.m08_sources import register_entries_loader, set_source_loader_for_testing, validate_entry
from kp.m09_evidence import MemoryEvidenceRepo, get_assertions, set_suppression_checker
from kp.m10_policy import set_psl_rules_for_testing
from kp.m19_classifiers import CLASSIFIER_SOURCE_ID, CuratedList, set_curated_list_for_testing
from kp.m20_discovery import (
    CrawledPage,
    DiscoverPayload,
    DiscoveryDeps,
    Extraction,
    SearchQuery,
    SearchResult,
    SearchUnavailable,
    build_queries,
    handle_discover,
    html_to_text,
    idempotency_key,
    internal_links,
    parse_discovery_config,
    parse_released,
    request_discovery,
    run_discovery,
    set_conn_factory_for_testing,
    set_deps_for_testing,
    short_term,
    verify_snippets,
)
from kp.m20_discovery.config import config_dir, parse_prewarm


def _src(id: str, source_type: str) -> Any:
    return validate_entry({"id": id, "source_type": source_type, "can_store": True, "can_display": True,
                           "can_export": True, "retention_days": None, "attribution_text": f"Source {id}",
                           "personal_data_class": "none", "allowed_regions": ["*"], "status": "active"})


SOURCES = [_src("web.crawl", "website"), _src(CLASSIFIER_SOURCE_ID, "operator")]
NOW = datetime(2026, 9, 27, 10, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _isolated() -> Iterator[None]:
    set_source_loader_for_testing(register_entries_loader(SOURCES))
    set_suppression_checker(None)
    set_psl_rules_for_testing("com\nuk\nco.uk\nde\nnl\nae\n")
    set_curated_list_for_testing(CuratedList.build([], []))
    yield
    set_deps_for_testing(None)
    set_conn_factory_for_testing(None)
    set_curated_list_for_testing(None)
    set_psl_rules_for_testing(None)
    set_source_loader_for_testing(None)


def _cfg() -> Any:
    with (config_dir() / "discovery.yaml").open(encoding="utf-8") as fh:
        return parse_discovery_config(yaml.safe_load(fh))


def _page(url: str, text: str, title: str = "Acme Foods Ltd | Home") -> CrawledPage:
    return CrawledPage(url=url, text=text, title=title, site_name=None, links=(), fetched_at=NOW,
                       raw_object_id="raw-1", sha256="0" * 64)


# ---- pure parts -----------------------------------------------------------------------------------

def test_config_files_parse() -> None:
    cfg = _cfg()
    assert cfg.languages_for("AE") == ("en", "ar")
    for name, parse in (("prewarm.yaml", parse_prewarm), ("discovery_released.yaml", parse_released)):
        with (config_dir() / name).open(encoding="utf-8") as fh:
            parse(yaml.safe_load(fh))
    with (config_dir() / "prewarm.yaml").open(encoding="utf-8") as fh:
        plan = parse_prewarm(yaml.safe_load(fh))
    assert set(plan.countries) == {"GB", "DE", "NL", "AE", "US"} and len(plan.headings) == 50


def test_queries_three_templates_per_language() -> None:
    cfg = _cfg()
    q_gb = build_queries("0306", "GB", "Crustaceans, whether in shell or not (shrimps); frozen", cfg)
    assert len(q_gb) == 3 and all(q.language == "en" and q.country == "GB" for q in q_gb)
    assert "importer UK" in q_gb[0].text
    q_de = build_queries("0306", "DE", "Crustaceans", cfg)
    assert len(q_de) == 3 and "Garnelen" in q_de[0].text and "Deutschland" in q_de[0].text
    assert len(build_queries("0306", "AE", "Crustaceans", cfg)) == 6


def test_short_term() -> None:
    assert short_term("Rice (paddy); husked") == "Rice"


def test_blocked_domains_and_suppression() -> None:
    from kp.m20_discovery import candidate_sites
    from kp.m20_discovery.models import DiscoveryRun

    cfg = _cfg()
    run = DiscoveryRun(run_id="r", country="GB", hs_heading="0306", reason="prewarm")
    results = [SearchResult(url=u, query="q") for u in (
        "https://www.amazon.co.uk/shrimp", "https://uk.linkedin.com/company/x", "https://www.acme.co.uk/about",
        "https://acme.co.uk/products", "https://bad.com/", "https://www.bbc.co.uk/news/1")]
    sites = candidate_sites(results, cfg, run, lambda kind, raw: raw == "bad.com")
    assert [s.domain for s in sites] == ["acme.co.uk"]
    assert sites[0].homepage == "https://www.acme.co.uk/"
    assert run.domains_suppressed == 1 and run.domains_blocked == 3


def test_html_to_text_and_internal_links() -> None:
    html = ("<html><head><title>Acme</title><script>var x=1</script></head><body><p>We import  frozen shrimp.</p>"
            "<a href='/about-us'>About</a><a href='/products/shrimp'>P</a><a href='https://other.com/contact'>x</a>"
            "<a href='/brochure.pdf'>pdf</a><a href='mailto:a@b.com'>m</a></body></html>")
    text, title, _site, hrefs = html_to_text(html)
    assert "We import frozen shrimp." in text
    assert "var x" not in text and title == "Acme"
    links = internal_links("https://acme.co.uk/", hrefs, "acme.co.uk", 5)
    assert links == ["https://acme.co.uk/about-us", "https://acme.co.uk/products/shrimp"]


def test_snippets_must_be_exact_substrings() -> None:
    pages = [_page("https://acme.co.uk/", "Acme Foods Ltd imports frozen shrimp from India and Vietnam.")]
    ex = Extraction.model_validate({"is_buyer_of_product": True, "confidence": 0.9, "snippets": [
        {"text": "imports frozen shrimp from India", "url": "https://acme.co.uk"},
        {"text": "imports frozen prawns from India", "url": "https://acme.co.uk/"},   # paraphrase
        {"text": "imports frozen shrimp", "url": "https://acme.co.uk/other"},         # wrong page
        {"text": "x" * 301, "url": "https://acme.co.uk/"},                             # too long
    ]})
    ok, dropped = verify_snippets(ex, pages)
    assert [s.text for s in ok] == ["imports frozen shrimp from India"] and dropped == 3
    assert ok[0].captured_at == NOW and ok[0].raw_object_id == "raw-1"


def test_idempotency_key_and_request() -> None:
    assert idempotency_key("0306", "gb", NOW) == "disc:0306:GB:2026-09-27"
    calls: list[tuple[str, tuple[Any, ...]]] = []

    class Tx:
        def execute(self, sql: str, params: Any = None) -> Any:
            calls.append((sql, params))
            return type("R", (), {"fetchone": staticmethod(lambda: ("job-1",))})()

    assert request_discovery(Tx(), "0306", "GB", requested_by="3b0f3c0e-1a1b-4c1d-8e1f-000000000001", now=NOW) == "job-1"
    params = calls[0][1]
    payload = json.loads(params[3])
    assert payload == {"hsHeading": "0306", "country": "GB", "reason": "on_demand",
                       "requestedBy": "3b0f3c0e-1a1b-4c1d-8e1f-000000000001"}
    assert params[5] == "disc:0306:GB:2026-09-27" and params[8] == "search_api"


def test_released_countries() -> None:
    r = parse_released({"min_precision": 0.8, "released": [
        {"country": "GB", "discovery_version": 1, "precision": 0.85},
        {"country": "DE", "discovery_version": 1, "precision": 0.7}]})
    assert r.is_released("gb") and not r.is_released("DE") and not r.is_released("NL")


# ---- end to end on the in-memory store -------------------------------------------------------------

class FakeSearch:
    def __init__(self, results: list[SearchResult] | None = None, fail: bool = False) -> None:
        self.results = results or []
        self.fail = fail
        self.queries: list[SearchQuery] = []

    def search(self, q: SearchQuery, *, max_results: int) -> list[SearchResult]:
        self.queries.append(q)
        if self.fail:
            raise SearchUnavailable("down")
        return self.results[:max_results]


class FakeCrawler:
    def __init__(self, pages: dict[str, list[CrawledPage]]) -> None:
        self.pages = pages

    def crawl_site(self, homepage: str) -> list[CrawledPage]:
        return self.pages.get(homepage, [])


def _classify_llm(req: LlmRequest) -> LlmResult:
    answer = {"is_logistics": False, "logistics_confidence": 0.9, "buyer_type": "importer",
              "type_confidence": 0.8, "citations": ["E1"]}
    return LlmResult(text=json.dumps(answer), model="fake", input_tokens=1, output_tokens=1, cached=False, json=answer)


def _deps(repo: MemoryEvidenceRepo, search: FakeSearch, extraction: dict[str, Any]) -> DiscoveryDeps:
    text = "Acme Foods Ltd, London. We import frozen shrimp from India for UK wholesalers."
    crawler = FakeCrawler({"https://www.acme.co.uk/": [_page("https://www.acme.co.uk/", text)]})
    return DiscoveryDeps(search=search, crawler=lambda: crawler, llm=lambda s, u: extraction,
                         tx=lambda: nullcontext(repo), heading_text=lambda h: "Crustaceans; frozen",
                         is_suppressed=lambda k, r: False, config=_cfg(), classify_llm=_classify_llm)


def test_end_to_end_writes_evidence_with_page_reference() -> None:
    repo = MemoryEvidenceRepo()
    search = FakeSearch([SearchResult(url="https://www.acme.co.uk/shrimp", query="frozen shrimp importer UK", rank=1)])
    extraction = {"is_buyer_of_product": True, "confidence": 0.87, "company_name": "Acme Foods Ltd", "city": "London",
                  "country": "GB", "snippets": [
                      {"text": "We import frozen shrimp from India", "url": "https://www.acme.co.uk/"},
                      {"text": "we sell shrimp", "url": "https://www.acme.co.uk/"}]}
    p = DiscoverPayload.model_validate({"hsHeading": "0306", "country": "GB", "reason": "on_demand"})
    run = run_discovery(p, _deps(repo, search, extraction), run_id="run-1")
    assert len(search.queries) == 3
    assert [s.outcome for s in run.sites] == ["written"] and run.new_companies == 1
    site = run.sites[0]
    ev = get_assertions(site.company_id, ["product_evidence"], tx=repo)
    assert len(ev) == 1
    a = ev[0]
    assert a.value == {"hs_heading": "0306", "snippet": "We import frozen shrimp from India",
                       "url": "https://www.acme.co.uk/"}
    assert a.llm_assisted and a.source_id == "web.crawl" and a.source_type == "website"
    assert a.source_ref["url"] == "https://www.acme.co.uk/" and a.source_ref["captured_at"] == NOW.isoformat()
    assert a.source_ref["raw_object_id"] == "raw-1" and a.source_ref["discovery_v"] == 1
    assert a.confidence == pytest.approx(0.87)
    bt = get_assertions(site.company_id, ["buyer_type"], tx=repo)
    assert bt and bt[0].value.get("type") == "importer"


def test_no_valid_snippets_discards_site() -> None:
    repo = MemoryEvidenceRepo()
    search = FakeSearch([SearchResult(url="https://www.acme.co.uk/", query="q", rank=1)])
    extraction = {"is_buyer_of_product": True, "confidence": 0.9, "company_name": None, "city": None,
                  "country": None, "snippets": [{"text": "invented quote", "url": "https://www.acme.co.uk/"}]}
    p = DiscoverPayload.model_validate({"hsHeading": "0306", "country": "GB", "reason": "prewarm"})
    run = run_discovery(p, _deps(repo, search, extraction))
    assert [s.outcome for s in run.sites] == ["no_valid_snippets"] and run.new_companies == 0


class FakeConn:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def execute(self, sql: str, params: Any = None) -> Any:
        if "platform.outbox" in sql:
            self.events.append((params[1], json.loads(params[2])))
        return type("R", (), {"fetchone": staticmethod(lambda: ("x",))})()


def _meta(attempt: int) -> JobMeta:
    return JobMeta(job_id="job-9", type="m20.discover", queue="knowledge", attempt=attempt, max_attempts=5,
                   correlation_id="c", actor_ref=None, idempotency_key="disc:0306:GB:2026-09-27", v=1, enqueued_at=None)


def test_search_outage_retries_then_completes_degraded() -> None:
    conn = FakeConn()

    @contextmanager
    def factory() -> Iterator[FakeConn]:
        yield conn

    set_conn_factory_for_testing(factory)
    set_deps_for_testing(_deps(MemoryEvidenceRepo(), FakeSearch(fail=True), {}))
    p = DiscoverPayload.model_validate({"hsHeading": "0306", "country": "GB", "reason": "on_demand"})
    for attempt in (1, 2):
        with pytest.raises(SearchUnavailable):
            handle_discover(p, _meta(attempt))
    assert conn.events == []
    run = handle_discover(p, _meta(3))
    assert run.degraded
    assert len(conn.events) == 1
    ev_type, payload = conn.events[0]
    assert ev_type == "discovery.completed"
    assert payload["newCompanies"] == 0 and payload["degraded"] is True
    assert payload["country"] == "GB" and payload["hsHeading"] == "0306"
