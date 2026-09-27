"""M19 tests over the in-memory evidence repo and a fake LLM (no network, no database)."""
from __future__ import annotations

from typing import Any, Iterator

import pytest

from kp.m03_llm import LlmRequest, LlmResult, detect_pii
from kp.m08_sources import register_entries_loader, set_source_loader_for_testing, validate_entry
from kp.m09_evidence import MemoryEvidenceRepo, create_company, get_assertions, set_suppression_checker, write_assertion
from kp.m10_policy import set_psl_rules_for_testing
from kp.m19_classifiers import (
    CLASSIFIER_SOURCE_ID,
    CuratedList,
    EvidenceText,
    build_prompt,
    classify,
    fold_name,
    keyword_hit,
    load_curated_list,
    redact,
    set_curated_list_for_testing,
)


def _src(id: str, source_type: str) -> Any:
    return validate_entry({"id": id, "source_type": source_type, "can_store": True, "can_display": True,
                           "can_export": True, "retention_days": None, "attribution_text": f"Source {id}",
                           "personal_data_class": "none", "allowed_regions": ["*"], "status": "active"})


SOURCES = [_src("web.crawl", "website"), _src("operator.manual", "operator"),
           _src(CLASSIFIER_SOURCE_ID, "operator"), _src("customs.us", "customs")]
CURATED = CuratedList.build(["dhl.com", "kuehne-nagel.com"], ["Kuehne + Nagel", "GAC"])


@pytest.fixture(autouse=True)
def _isolated() -> Iterator[None]:
    set_source_loader_for_testing(register_entries_loader(SOURCES))
    set_suppression_checker(None)
    set_psl_rules_for_testing("com\nuk\nco.uk\nde\n")
    set_curated_list_for_testing(CURATED)
    yield
    set_curated_list_for_testing(None)
    set_psl_rules_for_testing(None)
    set_source_loader_for_testing(None)


class FakeLlm:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer
        self.calls: list[LlmRequest] = []

    def __call__(self, req: LlmRequest) -> LlmResult:
        self.calls.append(req)
        return LlmResult(text="{}", model="fake-model", input_tokens=10, output_tokens=5, cached=False, json=self.answer)


def _company(repo: MemoryEvidenceRepo, name: str, domain: str | None = None) -> str:
    return create_company(repo, display_name=name, country="DE", city="Hamburg", primary_domain=domain)


def _evidence(repo: MemoryEvidenceRepo, cid: str, snippet: str) -> EvidenceText:
    url = "https://acme.de/products"
    aid = write_assertion({"subject_id": cid, "attribute": "product_evidence",
                           "value": {"hs_heading": "0901", "snippet": snippet, "url": url},
                           "source_id": "web.crawl", "source_ref": {"url": url, "captured_at": "2026-09-01T10:00:00Z"},
                           "confidence": 0.8, "producer": "m20", "producer_version": "1", "llm_assisted": True},
                          tx=repo)
    assert aid is not None
    return EvidenceText(assertion_id=aid, text=snippet, url=url, captured_at="2026-09-01T10:00:00Z", hs_heading="0901")


def _active(repo: MemoryEvidenceRepo, cid: str, attr: str) -> list[Any]:
    return [a for a in get_assertions(cid, [attr], tx=repo) if a.is_active]


def test_curated_domain_hit_flags_logistics_without_llm() -> None:
    repo = MemoryEvidenceRepo()
    cid = _company(repo, "Some Trading GmbH", "www.dhl.com")
    llm = FakeLlm({})
    c = classify(cid, [], tx=repo, llm=llm)
    assert c.is_logistics and c.logistics_confidence == 1.0 and c.logistics_method == "curated"
    assert llm.calls == []
    flags = _active(repo, cid, "logistics_flag")
    assert len(flags) == 1 and flags[0].source_id == CLASSIFIER_SOURCE_ID and flags[0].value["is_logistics"] is True


def test_curated_name_prefix_and_single_word_exact() -> None:
    assert CURATED.match_name("Kuehne + Nagel (UK) Ltd") is not None
    assert CURATED.match_name("GAC") is not None
    assert CURATED.match_name("GAC Foods") is None


def test_keyword_rules() -> None:
    assert keyword_hit("Hanseatic Freight Services GmbH") is not None
    assert keyword_hit("Nordic Logistikzentrum AG") is not None
    assert keyword_hit("ABC Customs Brokers Inc") is not None
    assert keyword_hit("Acme Coffee Importers") is None
    assert fold_name("Café & Co.") == "cafe and co"


def test_keyword_hit_confidence_085() -> None:
    repo = MemoryEvidenceRepo()
    cid = _company(repo, "Hamburg Freight Forwarders GmbH")
    c = classify(cid, [], tx=repo, llm=FakeLlm({}))
    assert c.is_logistics and c.logistics_confidence == 0.85 and c.buyer_type == "unknown"
    assert _active(repo, cid, "buyer_type") == []


def test_llm_buyer_type_with_citation_is_written() -> None:
    repo = MemoryEvidenceRepo()
    cid = _company(repo, "Acme Kaffee GmbH")
    ev = _evidence(repo, cid, "We import green coffee beans from Brazil and Vietnam.")
    llm = FakeLlm({"is_logistics": False, "logistics_confidence": 0.9, "buyer_type": "importer",
                   "type_confidence": 0.8, "citations": ["E1"]})
    c = classify(cid, [ev], tx=repo, llm=llm)
    assert c.buyer_type == "importer" and c.type_confidence == 0.8 and not c.is_logistics
    assert [str(x) for x in c.evidence_assertion_ids] == [str(ev.assertion_id)]
    assert llm.calls and llm.calls[0].tier == "classify" and llm.calls[0].pii_free
    bt = _active(repo, cid, "buyer_type")
    assert len(bt) == 1 and bt[0].value["type"] == "importer" and bt[0].llm_assisted
    assert bt[0].source_ref["evidence_assertion_ids"] == [str(ev.assertion_id)]
    # A negative logistics result writes nothing when there is no earlier classifier flag.
    assert _active(repo, cid, "logistics_flag") == []


def test_uncited_llm_result_is_unknown_and_not_written() -> None:
    repo = MemoryEvidenceRepo()
    cid = _company(repo, "Acme Kaffee GmbH")
    ev = _evidence(repo, cid, "We import green coffee beans.")
    llm = FakeLlm({"is_logistics": True, "logistics_confidence": 0.9, "buyer_type": "importer",
                   "type_confidence": 0.9, "citations": ["E7"]})
    c = classify(cid, [ev], tx=repo, llm=llm)
    assert c.buyer_type == "unknown" and not c.is_logistics and c.evidence_assertion_ids == []
    assert _active(repo, cid, "buyer_type") == [] and _active(repo, cid, "logistics_flag") == []


def test_operator_buyer_type_is_not_overwritten() -> None:
    repo = MemoryEvidenceRepo()
    cid = _company(repo, "Acme Kaffee GmbH")
    write_assertion({"subject_id": cid, "attribute": "buyer_type", "value": {"type": "retailer"},
                     "source_id": "operator.manual", "source_ref": {"by": "ops"}, "confidence": 1.0,
                     "producer": "m34", "producer_version": "1"}, tx=repo)
    ev = _evidence(repo, cid, "We distribute coffee brands to cafes.")
    llm = FakeLlm({"is_logistics": False, "logistics_confidence": 0.9, "buyer_type": "distributor",
                   "type_confidence": 0.9, "citations": ["E1"]})
    c = classify(cid, [ev], tx=repo, llm=llm)
    assert c.buyer_type == "distributor"
    bt = _active(repo, cid, "buyer_type")
    assert len(bt) == 1 and bt[0].value["type"] == "retailer"


def test_classifier_withdraws_its_own_flag() -> None:
    repo = MemoryEvidenceRepo()
    cid = _company(repo, "Acme Kaffee GmbH")
    ev = _evidence(repo, cid, "Freight forwarding and customs clearance for coffee importers.")
    classify(cid, [ev], tx=repo, llm=FakeLlm({"is_logistics": True, "logistics_confidence": 0.8,
                                              "buyer_type": "unknown", "type_confidence": 0, "citations": ["E1"]}))
    assert _active(repo, cid, "logistics_flag")[0].value["is_logistics"] is True
    classify(cid, [ev], tx=repo, llm=FakeLlm({"is_logistics": False, "logistics_confidence": 0.9,
                                              "buyer_type": "importer", "type_confidence": 0.7, "citations": ["E1"]}))
    flags = _active(repo, cid, "logistics_flag")
    assert len(flags) == 1 and flags[0].value["is_logistics"] is False


def test_prompt_is_redacted_and_pii_free() -> None:
    ev = EvidenceText(assertion_id="00000000-0000-0000-0000-000000000001",
                      text="Contact sales@acme.de or +49 40 1234 5678 for coffee imports.")
    p = build_prompt("Acme", "DE", [ev])
    assert "E1" in p.labels and not detect_pii(p.user)
    assert "[email]" in redact("x sales@acme.de y")


def test_curated_config_file_parses() -> None:
    set_curated_list_for_testing(None)
    lst = load_curated_list()
    assert "dhl.com" in lst.domains and lst.match_name("Kuehne + Nagel (UK) Ltd")
