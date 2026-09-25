"""M09 tests (LLD M09 "Tests" plus the invariants around them). In-memory repo; no database."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import pytest

from kp.m08_sources import SourceNotActive, register_entries_loader, set_source_loader_for_testing, validate_entry
from kp.m09_evidence import (
    EV_ENTITY_CHANGED,
    PROJECT_JOB,
    AssertionCommand,
    InvalidAttribute,
    MemoryEvidenceRepo,
    MissingPageReference,
    PersonalDataDisabled,
    add_anchor,
    build_projection,
    contact_value_hash,
    counters,
    create_company,
    find_by_anchor,
    get_assertions,
    handle_command,
    negate,
    norm_hash,
    project_company,
    purge_for_suppression,
    put_contact_value,
    resolve_company_id,
    set_suppression_checker,
    stale,
    write_assertion,
)
from kp.m09_evidence.models import MergeCycle


def _src(id: str, source_type: str, *, display: bool = True, export: bool = True, pdc: str = "none",
         status: str = "active") -> Any:
    return validate_entry({
        "id": id, "source_type": source_type, "can_store": status != "prohibited",
        "can_display": display and status != "prohibited", "can_export": export and display and status != "prohibited",
        "retention_days": None, "attribution_text": f"Source {id}", "personal_data_class": pdc,
        "allowed_regions": ["*"], "status": status,
    })


SOURCES = [
    _src("web.crawl", "website", pdc="business_contact"),
    _src("market_stats.un.comtrade", "market_stats", export=False),
    _src("user_report", "user_report", display=False, export=False, pdc="business_contact"),
    _src("operator.manual", "operator", pdc="business_contact"),
    _src("customs.us", "customs"),
    _src("old.directory", "directory", status="disabled"),
]


@pytest.fixture(autouse=True)
def _sources() -> Iterable[None]:
    set_source_loader_for_testing(register_entries_loader(SOURCES))
    set_suppression_checker(None)
    yield
    set_source_loader_for_testing(None)
    set_suppression_checker(None)


@pytest.fixture()
def repo() -> MemoryEvidenceRepo:
    return MemoryEvidenceRepo()


def _company(repo: MemoryEvidenceRepo, name: str = "Acme Trading GmbH", domain: str | None = "acme.de") -> str:
    return create_company(repo, display_name=name, country="DE", city="Hamburg", primary_domain=domain,
                          anchors=[("registry", "DE:hrb:HRB 12345")])


def _page_ref(url: str = "https://acme.de/products") -> dict[str, Any]:
    return {"url": url, "captured_at": "2026-09-01T10:00:00Z"}


def _evidence(cid: str, heading: str = "7208", snippet: str = "We import hot-rolled steel coils", **over: Any) -> dict:
    a = {"subject_id": cid, "attribute": "product_evidence",
         "value": {"hs_heading": heading, "snippet": snippet, "url": "https://acme.de/products"},
         "source_id": "web.crawl", "source_ref": _page_ref(), "confidence": 0.8, "producer": "m20",
         "producer_version": "1"}
    a.update(over)
    return a


def _contact(cid: str, kind: str, raw: str, **over: Any) -> dict:
    a = {"subject_id": cid, "attribute": f"contact.{kind}",
         "value": {"value_hash": contact_value_hash(kind, raw), "display_mask": "s***@acme.de"},
         "source_id": "web.crawl", "source_ref": _page_ref("https://acme.de/contact"), "confidence": 0.9,
         "producer": "m22", "producer_version": "1"}
    a.update(over)
    return a


# ---- LLD tests -------------------------------------------------------------------------------

def test_llm_assisted_write_without_url_is_rejected(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    with pytest.raises(MissingPageReference):
        write_assertion(_evidence(cid, llm_assisted=True, source_ref={"captured_at": "2026-09-01"}), tx=repo)
    with pytest.raises(MissingPageReference):
        write_assertion(_evidence(cid, llm_assisted=True, source_ref={"url": "https://acme.de"}), tx=repo)
    assert write_assertion(_evidence(cid, llm_assisted=True), tx=repo) is not None


def test_suppressed_domain_is_skipped(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo, domain=None)
    repo.suppression.add(norm_hash("domain", "blocked-example.com"))
    before = counters()["suppressed_skip"]
    out = write_assertion(_contact(cid, "website", "https://www.blocked-example.com/"), tx=repo)
    assert out is None
    assert counters()["suppressed_skip"] == before + 1
    assert get_assertions(cid, ["contact.website"], tx=repo) == []
    # Evidence whose page lives on the suppressed domain is skipped too.
    assert write_assertion(_evidence(cid, value={"hs_heading": "7208", "snippet": "x",
                                                 "url": "http://blocked-example.com/p"}), tx=repo) is None
    # An installed M10 checker takes precedence over the table.
    set_suppression_checker(lambda hashes: set())
    assert write_assertion(_contact(cid, "website", "https://www.blocked-example.com/"), tx=repo) is not None


def test_supersede_keeps_history(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    first = write_assertion({**_evidence(cid), "observed_at": datetime(2026, 1, 1, tzinfo=timezone.utc)}, tx=repo)
    second = write_assertion(_evidence(cid, snippet="We buy cold-rolled coil"), tx=repo)
    other_heading = write_assertion(_evidence(cid, heading="7209"), tx=repo)
    assert first and second and other_heading and first != second
    active = get_assertions(cid, ["product_evidence"], tx=repo)
    assert {a.id for a in active} == {second, other_heading}
    history = get_assertions(cid, ["product_evidence"], include_superseded=True, tx=repo)
    old = next(a for a in history if a.id == first)
    assert old.superseded_by == second
    assert old.value["snippet"] == "We import hot-rolled steel coils"


def test_equal_value_only_refreshes_checked_at(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    t0 = datetime(2026, 5, 1, tzinfo=timezone.utc)
    first = write_assertion({**_contact(cid, "role_email", "sales@acme.de"), "observed_at": t0}, tx=repo)
    t1 = datetime(2026, 9, 1, tzinfo=timezone.utc)
    again = write_assertion({**_contact(cid, "role_email", "sales@acme.de"), "observed_at": t1, "checked_at": t1},
                            tx=repo)
    assert again == first
    rows = get_assertions(cid, ["contact.role_email"], include_superseded=True, tx=repo)
    assert len(rows) == 1 and rows[0].checked_at == t1 and rows[0].observed_at == t0


def test_projection_never_contains_contact_values(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    write_assertion(_evidence(cid), tx=repo)
    raw_values = {"role_email": "sales@acme.de", "phone": "+49 40 1234567", "address": "Hafenstrasse 1, Hamburg"}
    for kind, raw in raw_values.items():
        aid = write_assertion(_contact(cid, kind, raw), tx=repo)
        put_contact_value(repo, aid, kind, raw)
    res = project_company(repo, cid)
    assert res is not None and res.profile_row is not None
    blob = json.dumps([repo.profile_docs[cid], *repo.search_docs.values()], default=str)
    for raw in raw_values.values():
        assert raw not in blob
        assert raw.lower() not in blob.lower()
    slots = repo.profile_docs[cid]["doc"]["contacts"]
    assert {s["kind"] for s in slots} == set(raw_values)
    for s in slots:
        assert set(s) == {"assertion_id", "kind", "source_type", "checked_at", "deliverability"}
    assert len(repo.contact_values) == 3


# ---- validation order ------------------------------------------------------------------------

def test_invalid_attribute_inactive_source_and_named_person(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    with pytest.raises(InvalidAttribute):
        write_assertion(_evidence(cid, attribute="person.name"), tx=repo)
    with pytest.raises(InvalidAttribute):
        write_assertion(_evidence(cid, value={"hs_heading": "72", "snippet": "x"}), tx=repo)
    with pytest.raises(SourceNotActive):
        write_assertion(_evidence(cid, source_id="old.directory"), tx=repo)
    with pytest.raises(PersonalDataDisabled):
        write_assertion(_evidence(cid, personal_data_class="named_person"), tx=repo)
    with pytest.raises(PersonalDataDisabled):
        write_assertion(_evidence(cid, subject_type="person"), tx=repo)
    with pytest.raises(InvalidAttribute):  # contact values must never sit in an assertion
        write_assertion(_contact(cid, "role_email", "a@acme.de",
                                 value={"value_hash": "0" * 64, "email": "a@acme.de"}), tx=repo)


def test_licence_flags_are_inherited_and_only_tightened(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    a1 = write_assertion(_evidence(cid, source_id="market_stats.un.comtrade", can_export=True), tx=repo)
    a2 = write_assertion(_evidence(cid, heading="7209", can_display=False), tx=repo)
    rows = {a.id: a for a in get_assertions(cid, tx=repo)}
    assert rows[a1].can_display is True and rows[a1].can_export is False
    assert rows[a1].source_type == "market_stats"
    assert rows[a2].can_display is False and rows[a2].can_export is False
    assert rows[a2].personal_data_class == "business_contact"
    assert rows[a2].region == "DE"


def test_ev01_emitted_with_attribute_classes(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    repo.events.clear()
    write_assertion(_contact(cid, "phone", "+49 40 1234567"), tx=repo)
    assert repo.events == [(EV_ENTITY_CHANGED, {"company_id": cid, "attribute_classes": ["contact"]})]


# ---- projection ------------------------------------------------------------------------------

def test_projection_docs_and_hidden_facts(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    ev = write_assertion(_evidence(cid), tx=repo)
    write_assertion({"subject_id": cid, "attribute": "activity_aggregate",
                     "value": {"hs_heading": "7208", "shipments_12m": 14, "volume_kg_12m": 250000,
                               "origins": {"IN": 3, "CN": 11}, "top_suppliers": [], "last_seen": "2026-08-20"},
                     "source_id": "customs.us", "source_ref": {"batch_week": "2026-W34", "row_count": 14},
                     "confidence": 0.95, "producer": "m21", "producer_version": "1"}, tx=repo)
    write_assertion(_evidence(cid, heading="3901"), tx=repo)
    hidden = write_assertion(_evidence(cid, heading="4011", source_id="user_report", source_ref={"report_id": "r1"}),
                             tx=repo)
    write_assertion({"subject_id": cid, "attribute": "buyer_type", "value": {"type": "importer"},
                     "source_id": "web.crawl", "source_ref": _page_ref(), "confidence": 0.7, "producer": "m20",
                     "producer_version": "1"}, tx=repo)
    project_company(repo, cid)
    profile = repo.profile_docs[cid]["doc"]
    assert profile["hidden_assertion_ids"] == [hidden]
    assert all(e["assertion_id"] != hidden for e in profile["evidence"])
    for fact in profile["facts"]:  # REQ-033: source and last-checked on every fact
        assert fact["source_type"] and fact["checked_at"] and fact["source_id"]
    assert set(k[1] for k in repo.search_docs) == {"7208", "3901"}
    steel = repo.search_docs[(cid, "7208")]
    assert steel["origin_india"] == "yes" and steel["origin_competitor"] == "yes"
    assert steel["shipment_freq"] == 14 and str(steel["last_activity"]) == "2026-08-20"
    assert steel["doc"]["strongest_source_type"] == "customs"
    assert steel["buyer_type"] == "importer"
    plastics = repo.search_docs[(cid, "3901")]
    assert plastics["origin_india"] == "unknown" and plastics["origin_competitor"] == "unknown"
    assert norm_hash("company_id", cid) in steel["identifier_hashes"]
    assert norm_hash("domain", "acme.de") in steel["identifier_hashes"]
    assert ev in steel["doc"]["assertion_ids"]


def test_negative_assertion_removes_contact_slot(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    write_assertion(_evidence(cid), tx=repo)
    t0 = datetime.now(timezone.utc) - timedelta(days=10)
    write_assertion({**_contact(cid, "role_email", "sales@acme.de"), "observed_at": t0}, tx=repo)
    h = contact_value_hash("role_email", "sales@acme.de")
    negate(cid, "contact.role_email", {"value_hash": h}, "operator.manual", {"reverify": "x"}, tx=repo)
    project_company(repo, cid)
    assert repo.profile_docs[cid]["doc"]["contacts"] == []
    assert repo.search_docs[(cid, "7208")]["contact_types"] == []
    # History: the positive remains and the negative is its own assertion.
    rows = get_assertions(cid, ["contact.role_email"], tx=repo)
    assert {r.polarity for r in rows} == {"positive", "negative"}


def test_closed_company_keeps_profile_only(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    write_assertion(_evidence(cid), tx=repo)
    project_company(repo, cid)
    assert repo.search_docs
    handle_command(AssertionCommand(kind="report_closed", subject_id=cid, payload={}, actor="op:1"), repo)
    project_company(repo, cid)
    assert not repo.search_docs
    assert repo.profile_docs[cid]["doc"]["status"] == "closed"


def test_not_buyer_for_removes_heading(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    write_assertion(_evidence(cid), tx=repo)
    write_assertion(_evidence(cid, heading="7209"), tx=repo)
    handle_command(AssertionCommand(kind="report_not_buyer", subject_id=cid, payload={"hs_heading": "7208"},
                                    actor="op:1"), repo)
    project_company(repo, cid)
    assert set(k[1] for k in repo.search_docs) == {"7209"}


def test_suppression_event_purges_and_rebuild_drops_company(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    write_assertion(_evidence(cid), tx=repo)
    project_company(repo, cid)
    dh = norm_hash("domain", "acme.de")
    repo.suppression.add(dh)
    purged = purge_for_suppression(repo, [dh], event_id="e1")
    assert purged == [cid] and not repo.search_docs and cid not in repo.profile_docs
    assert (PROJECT_JOB, f"{cid}:now:e1") in repo.jobs
    project_company(repo, cid)  # the rebuild keeps the company out
    assert not repo.search_docs and cid not in repo.profile_docs


def test_sanctions_decision_blocks(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    write_assertion(_evidence(cid), tx=repo)
    handle_command(AssertionCommand(kind="sanctions_decision", subject_id=cid, payload={"decision": "confirmed"},
                                    actor="op:2"), repo)
    project_company(repo, cid)
    assert repo.profile_docs[cid]["sanctions_block"] is True
    assert repo.search_docs[(cid, "7208")]["sanctions_block"] is True


# ---- companies and merges --------------------------------------------------------------------

def test_merge_confirm_follows_through(repo: MemoryEvidenceRepo) -> None:
    a = _company(repo)
    b = create_company(repo, display_name="ACME Trading", country="DE", primary_domain="acme-trading.de")
    write_assertion(_evidence(a), tx=repo)
    write_assertion(_evidence(b, snippet="newer snippet"), tx=repo)
    project_company(repo, b)
    handle_command(AssertionCommand(kind="merge_confirm", subject_id=b, payload={"into": a}, actor="op:3"), repo)
    assert resolve_company_id(b, tx=repo) == a
    assert find_by_anchor("domain", "acme-trading.de", tx=repo) == a
    active = get_assertions(a, ["product_evidence"], tx=repo)
    assert len(active) == 1 and active[0].value["snippet"] == "newer snippet"
    assert len(get_assertions(a, ["product_evidence"], include_superseded=True, tx=repo)) == 2
    assert b not in repo.profile_docs
    project_company(repo, b)  # an EV-01 for the old id rebuilds the target
    assert a in repo.profile_docs and b not in repo.profile_docs


def test_resolve_raises_on_cycle(repo: MemoryEvidenceRepo) -> None:
    a = _company(repo)
    b = create_company(repo, display_name="B", country="DE")
    repo.update_company(a, {"status": "merged", "merged_into": b})
    repo.update_company(b, {"status": "merged", "merged_into": a})
    with pytest.raises(MergeCycle):
        resolve_company_id(a, tx=repo)


def test_anchor_lookup_normalises(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    add_anchor(repo, cid, "vat", "de 123-456-789")
    assert find_by_anchor("vat", "DE123456789", tx=repo) == cid
    assert find_by_anchor("domain", "https://www.ACME.de/about", tx=repo) == cid
    assert find_by_anchor("domain", "other.de", tx=repo) is None


def test_stale_returns_old_positive_facts(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    old = datetime.now(timezone.utc) - timedelta(days=120)
    aid = write_assertion({**_contact(cid, "phone", "+49 40 1234567"), "observed_at": old}, tx=repo)
    write_assertion(_contact(cid, "role_email", "info@acme.de"), tx=repo)
    rows = stale("contact.", timedelta(days=90), 100, tx=repo)
    assert [r.id for r in rows] == [aid]


def test_build_projection_is_pure(repo: MemoryEvidenceRepo) -> None:
    cid = _company(repo)
    write_assertion(_evidence(cid), tx=repo)
    company = repo.get_company(cid)
    assert company is not None
    res = build_projection(company, repo.list_assertions(cid, None, False), repo.anchors_of(cid), lambda h: set())
    assert not repo.profile_docs and res.profile_row is not None and len(res.search_rows) == 1
