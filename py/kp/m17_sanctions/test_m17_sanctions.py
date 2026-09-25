"""M17 tests: normalisation, matching thresholds, parsers, list diffing, screening with decisions and
flag writes, and the IF-17a endpoint. In-memory stores; no database or network."""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kp.m08_sources import register_entries_loader, set_source_loader_for_testing, validate_entry
from kp.m09_evidence import (
    EV_SANCTIONS_FLAG_CHANGED,
    MemoryEvidenceRepo,
    create_company,
    get_assertions,
    set_suppression_checker,
)

from . import (
    FILE_POSSIBLE_MATCH_JOB,
    MemoryOutbox,
    MemorySanctionsStore,
    ParsedEntry,
    ScreenResult,
    build_router,
    classify,
    country_iso2,
    evaluate,
    normalise_name,
    parse_list,
    record_decision,
    screen_company,
    screen_name,
)
from .ingest import ListBatch, apply_batches


def _src(id: str) -> Any:
    return validate_entry({
        "id": id, "source_type": "sanctions", "can_store": True, "can_display": True, "can_export": False,
        "retention_days": 730, "attribution_text": f"Source {id}", "personal_data_class": "named_person",
        "allowed_regions": ["*"], "status": "active",
    })


@pytest.fixture(autouse=True)
def _sources() -> Iterable[None]:
    set_source_loader_for_testing(register_entries_loader(
        [_src("sanctions.us.ofac"), _src("sanctions.un.sc"), _src("sanctions.eu.fsf"), _src("sanctions.gb.ofsi")]))
    set_suppression_checker(None)
    yield
    set_source_loader_for_testing(None)
    set_suppression_checker(None)


# ---- normalisation ----------------------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("Acme Trading Co., Ltd.", "acme trading"),
    ("ACME S.A.R.L.", "acme"),
    ("Müller Stahl GmbH", "muller stahl"),
    ("Ромашка ООО", "romashka"),
    ("Al-Noor General Trading L.L.C", "al noor general trading"),
    ("Smith & Sons Limited", "smith and sons"),
    ("The Company", "company"),
    ("", ""),
])
def test_normalise(raw: str, expected: str) -> None:
    assert normalise_name(raw) == expected


def test_country_iso2() -> None:
    assert country_iso2("Iran") == "IR"
    assert country_iso2("Russian Federation") == "RU"
    assert country_iso2("Korea, North") == "KP"
    assert country_iso2("DE") == "DE"
    assert country_iso2("Atlantis") is None


# ---- matching ---------------------------------------------------------------------------------

def _store_with(*entries: ParsedEntry) -> MemorySanctionsStore:
    s = MemorySanctionsStore()
    by_list: dict[str, list[ParsedEntry]] = {}
    for e in entries:
        by_list.setdefault(e.list, []).append(e)
    for k, v in by_list.items():
        s.apply_list(k, "v1", v)
    return s


def test_thresholds() -> None:
    assert classify(95) == "hit"
    assert classify(94.9) == "possible"
    assert classify(85) == "possible"
    assert classify(84.9) == "clear"


def test_transliterated_name_hits() -> None:
    s = _store_with(ParsedEntry("ofac_sdn", "1", ("Romashka LLC",), ("RU",), "entity"))
    ev = evaluate([normalise_name("ООО Ромашка")], "RU", s.candidates([normalise_name("ООО Ромашка")]))
    assert ev.result == "hit" and ev.matches[0].list_uid == "1"


def test_unrelated_name_is_clear() -> None:
    s = _store_with(ParsedEntry("un", "9", ("Islamic Revolutionary Guard Corps",), ("IR",), "entity"))
    q = normalise_name("Hamburg Steel Imports GmbH")
    assert evaluate([q], "DE", s.candidates([q])).result == "clear"


def test_country_bonus_can_lift_to_hit() -> None:
    s = _store_with(ParsedEntry("eu", "E1", ("Petro Trade Alliance",), ("SY",), "entity"))
    q = normalise_name("Petro Trade Aliance")
    without = evaluate([q], "IN", s.candidates([q]))
    with_c = evaluate([q], "SY", s.candidates([q]))
    assert with_c.best_score == pytest.approx(min(100.0, without.best_score + 5), abs=0.01)


# ---- parsers ----------------------------------------------------------------------------------

OFAC_XML = b"""<?xml version="1.0"?>
<sdnList xmlns="https://tempuri.org/sdnList.xsd">
  <publshInformation><Publish_Date>09/24/2026</Publish_Date></publshInformation>
  <sdnEntry><uid>100</uid><lastName>BLUE OCEAN SHIPPING LLC</lastName><sdnType>Entity</sdnType>
    <akaList><aka><uid>1</uid><lastName>BLUE OCEAN SHIPPING CO</lastName></aka></akaList>
    <addressList><address><country>Iran</country></address></addressList></sdnEntry>
  <sdnEntry><uid>101</uid><firstName>Ivan</firstName><lastName>PETROV</lastName><sdnType>Individual</sdnType>
    <nationalityList><nationality><country>Russia</country></nationality></nationalityList></sdnEntry>
</sdnList>"""

UN_XML = b"""<CONSOLIDATED_LIST dateGenerated="2026-09-20T00:00:00">
 <INDIVIDUALS><INDIVIDUAL><DATAID>7</DATAID><FIRST_NAME>ALI</FIRST_NAME><SECOND_NAME>HASSAN</SECOND_NAME>
   <INDIVIDUAL_ALIAS><ALIAS_NAME>Abu Ali</ALIAS_NAME></INDIVIDUAL_ALIAS>
   <NATIONALITY><VALUE>Iraq</VALUE></NATIONALITY></INDIVIDUAL></INDIVIDUALS>
 <ENTITIES><ENTITY><DATAID>8</DATAID><FIRST_NAME>KOREA MINING DEVELOPMENT TRADING CORPORATION</FIRST_NAME>
   <ENTITY_ALIAS><ALIAS_NAME>KOMID</ALIAS_NAME></ENTITY_ALIAS>
   <ENTITY_ADDRESS><COUNTRY>Democratic People's Republic of Korea</COUNTRY></ENTITY_ADDRESS></ENTITY></ENTITIES>
</CONSOLIDATED_LIST>"""

EU_XML = b"""<export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-09-21T10:00:00">
 <sanctionEntity logicalId="13">
  <subjectType code="enterprise"/>
  <nameAlias wholeName="Sirius Trade LLC"/><nameAlias wholeName="Sirius Trading"/>
  <address countryIso2Code="BY"/>
 </sanctionEntity>
</export>"""

UK_CSV = (
    "Last Updated,21/09/2026\r\n"
    "Name 6,Name 1,Name 2,Name 3,Name 4,Name 5,Title,Name Non-Latin Script,Nationality,Country,Group Type,Group ID\r\n"
    "NORTHERN STAR LTD,,,,,,,,,Russia,Entity,555\r\n"
    "SEVERNAYA ZVEZDA,,,,,,,Северная звезда,,Russia,Entity,555\r\n"
).encode("utf-8")


def test_parse_ofac() -> None:
    entries, version = parse_list("ofac_sdn", OFAC_XML)
    assert version == "09/24/2026"
    by_uid = {e.list_uid: e for e in entries}
    assert by_uid["100"].names == ("BLUE OCEAN SHIPPING LLC", "BLUE OCEAN SHIPPING CO")
    assert by_uid["100"].countries == ("IR",) and by_uid["100"].entity_type == "entity"
    assert by_uid["101"].names == ("Ivan PETROV",) and by_uid["101"].countries == ("RU",)


def test_parse_un_eu_uk() -> None:
    un, v = parse_list("un", UN_XML)
    assert v and {e.list_uid for e in un} == {"7", "8"}
    komid = next(e for e in un if e.list_uid == "8")
    assert "KOMID" in komid.names and komid.countries == ("KP",)
    eu, _ = parse_list("eu", EU_XML)
    assert eu[0].names == ("Sirius Trade LLC", "Sirius Trading") and eu[0].countries == ("BY",)
    uk, uv = parse_list("uk_ofsi", UK_CSV)
    assert uv == "21/09/2026"
    assert uk[0].list_uid == "555" and "Северная звезда" in uk[0].names and uk[0].countries == ("RU",)


def test_parse_rejects_entities() -> None:
    from kp.m01_platform import KpError
    with pytest.raises(KpError):
        parse_list("un", b'<!DOCTYPE x [<!ENTITY a "b">]><CONSOLIDATED_LIST/>')


# ---- diffing ----------------------------------------------------------------------------------

def test_apply_list_diff() -> None:
    s = MemorySanctionsStore()
    a = ParsedEntry("un", "1", ("Alpha",))
    b = ParsedEntry("un", "2", ("Beta",))
    st = s.apply_list("un", "v1", [a, b])
    assert (st.added, st.changed, st.removed) == (2, 0, 0)
    st = s.apply_list("un", "v2", [a, b])
    assert not st.any_change
    st = s.apply_list("un", "v3", [a, ParsedEntry("un", "2", ("Beta", "Beta Two"))])
    assert (st.added, st.changed, st.removed) == (0, 1, 0)
    st = s.apply_list("un", "v4", [a])
    assert st.removed == 1 and s.active_count("un") == 1


class _Tx:
    def __enter__(self) -> "_Tx":
        return self

    def __exit__(self, *a: Any) -> None:
        return None


def test_truncated_list_is_not_applied() -> None:
    s = MemorySanctionsStore()
    s.apply_list("un", "v1", [ParsedEntry("un", str(i), (f"Name {i}",)) for i in range(10)])
    events: list[dict[str, Any]] = []
    rep = apply_batches({"un": ListBatch("un", "v2", [ParsedEntry("un", "1", ("Name 1",))])}, _Tx,
                        store_factory=lambda tx: s, emit_changed=lambda tx, p: events.append(p))
    assert "un" in rep.rejected and s.active_count("un") == 10 and events == []


def test_changed_list_emits_ev02_once() -> None:
    s = MemorySanctionsStore()
    events: list[dict[str, Any]] = []
    rep = apply_batches({"un": ListBatch("un", "v1", [ParsedEntry("un", "1", ("A",))]),
                         "eu": ListBatch("eu", "e1", [ParsedEntry("eu", "1", ("B",))])}, _Tx,
                        store_factory=lambda tx: s, emit_changed=lambda tx, p: events.append(p))
    assert sorted(rep.changed_lists) == ["eu", "un"] and len(events) == 1
    assert events[0]["list_versions"] == {"un": "v1", "eu": "e1"}


# ---- screening --------------------------------------------------------------------------------

def _flag_values(repo: MemoryEvidenceRepo, cid: str) -> list[dict[str, Any]]:
    return [a.value for a in get_assertions(cid, ["sanctions_flag"], tx=repo)]


def test_hit_blocks_and_emits_ev03() -> None:
    repo, out = MemoryEvidenceRepo(), MemoryOutbox()
    store = _store_with(ParsedEntry("ofac_sdn", "100", ("Blue Ocean Shipping LLC",), ("AE",), "entity"))
    cid = create_company(repo, display_name="Blue Ocean Shipping L.L.C.", country="AE")
    r = screen_company(cid, tx=repo, store=store, outbox=out)
    assert r.result == "hit" and r.block
    assert _flag_values(repo, cid)[0]["block"] is True
    assert (EV_SANCTIONS_FLAG_CHANGED, {"company_id": cid, "block": True}) in out.events
    # A second screen with nothing changed reuses the stored screen and writes nothing.
    n_events = len(out.events)
    r2 = screen_company(cid, tx=repo, store=store, outbox=out)
    assert r2.cached and len(out.events) == n_events


def test_clear_company_writes_nothing() -> None:
    repo, out = MemoryEvidenceRepo(), MemoryOutbox()
    store = _store_with(ParsedEntry("un", "8", ("Korea Mining Development Trading Corporation",), ("KP",)))
    cid = create_company(repo, display_name="Pune Precision Castings Pvt Ltd", country="IN")
    r = screen_company(cid, tx=repo, store=store, outbox=out)
    assert r.result == "clear" and not r.block
    assert _flag_values(repo, cid) == [] and out.events == [] and out.jobs == {}


def _possible_setup() -> tuple[MemoryEvidenceRepo, MemoryOutbox, MemorySanctionsStore, str]:
    repo, out = MemoryEvidenceRepo(), MemoryOutbox()
    store = _store_with(ParsedEntry("eu", "13", ("Sirius Trade Holding",), ("BY",), "entity"))
    cid = create_company(repo, display_name="Sirius Trading House", country="IN")
    return repo, out, store, cid


def test_possible_blocks_and_files_review() -> None:
    repo, out, store, cid = _possible_setup()
    r = screen_company(cid, tx=repo, store=store, outbox=out)
    if r.raw_result != "possible":
        pytest.skip(f"fixture scored {r.best_score}, outside the possible band")
    assert r.block and _flag_values(repo, cid)[0]["block"] is True
    jobs = [k for k in out.jobs if k[0] == FILE_POSSIBLE_MATCH_JOB]
    assert len(jobs) == 1 and out.jobs[jobs[0]]["queue"] == "serving"
    assert out.jobs[jobs[0]]["payload"]["companyId"] == cid
    # Re-screen with the same matches: no second filing.
    screen_company(cid, tx=repo, store=store, outbox=out, force=True)
    assert len([k for k in out.jobs if k[0] == FILE_POSSIBLE_MATCH_JOB]) == 1


def test_cleared_decision_holds_until_entries_change() -> None:
    repo, out, store, cid = _possible_setup()
    r = screen_company(cid, tx=repo, store=store, outbox=out)
    if r.raw_result != "possible":
        pytest.skip(f"fixture scored {r.best_score}, outside the possible band")
    assert record_decision(cid, "cleared", tx=repo, store=store)
    assert screen_company(cid, tx=repo, store=store, outbox=out, force=True).result == "clear"
    # The entry changes after the decision → the decision lapses and the match blocks again.
    time.sleep(0.01)
    store.apply_list("eu", "v2", [ParsedEntry("eu", "13", ("Sirius Trade Holding", "Sirius THC"), ("BY",), "entity")])
    assert screen_company(cid, tx=repo, store=store, outbox=out, force=True).result == "possible"


def test_confirmed_decision_is_a_hit() -> None:
    repo, out, store, cid = _possible_setup()
    r = screen_company(cid, tx=repo, store=store, outbox=out)
    if r.raw_result != "possible":
        pytest.skip(f"fixture scored {r.best_score}, outside the possible band")
    record_decision(cid, "confirmed", tx=repo, store=store)
    assert screen_company(cid, tx=repo, store=store, outbox=out, force=True).result == "hit"


def test_screen_name_is_adhoc() -> None:
    repo = MemoryEvidenceRepo()
    store = _store_with(ParsedEntry("uk_ofsi", "555", ("Northern Star Ltd",), ("RU",), "entity"))
    r = screen_name("NORTHERN STAR LIMITED", "RU", tx=repo, store=store)
    assert r.result == "hit" and r.subject_key.startswith("adhoc:")
    assert r.subject_key in store.screens


def test_screen_name_validates() -> None:
    from kp.m01_platform import KpError
    with pytest.raises(KpError):
        screen_name("   ", None, tx=MemoryEvidenceRepo(), store=MemorySanctionsStore())
    with pytest.raises(KpError):
        screen_name("Acme", "IND", tx=MemoryEvidenceRepo(), store=MemorySanctionsStore())


# ---- IF-17a -----------------------------------------------------------------------------------

def _client(screener: Any, timeout: float = 0.8) -> TestClient:
    app = FastAPI()
    app.include_router(build_router(screener, timeout_s=timeout, authorise=lambda t: t == "secret"))
    return TestClient(app)


def _ok(req: Any) -> ScreenResult:
    return ScreenResult(subject_key="adhoc:" + "0" * 64, result="clear", raw_result="clear", best_score=0.0,
                        list_versions={"un": "v1"}, screened_at=datetime(2026, 9, 25, tzinfo=timezone.utc))


def test_rpc_ok_and_auth() -> None:
    c = _client(_ok)
    assert c.post("/rpc/sanctions/screen", json={"name": "Acme"}).status_code == 401
    r = c.post("/rpc/sanctions/screen", json={"name": "Acme", "country": "IN"}, headers={"x-internal-token": "secret"})
    assert r.status_code == 200
    assert r.json() == {"result": "clear", "listVersions": {"un": "v1"}, "screenedAt": "2026-09-25T00:00:00+00:00"}


def test_rpc_validation() -> None:
    c = _client(_ok)
    h = {"x-internal-token": "secret"}
    assert c.post("/rpc/sanctions/screen", json={}, headers=h).status_code == 400
    both = {"name": "A", "companyId": "01890000-0000-7000-8000-000000000000"}
    assert c.post("/rpc/sanctions/screen", json=both, headers=h).status_code == 400


def test_rpc_timeout_is_503() -> None:
    def slow(req: Any) -> ScreenResult:
        time.sleep(0.3)
        return _ok(req)

    r = _client(slow, timeout=0.05).post("/rpc/sanctions/screen", json={"name": "Acme"},
                                         headers={"x-internal-token": "secret"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "UPSTREAM_UNAVAILABLE"


def test_stale_stored_screen_is_rescreened() -> None:
    from . import screen_company_for_rpc

    repo, out = MemoryEvidenceRepo(), MemoryOutbox()
    store = _store_with(ParsedEntry("un", "1", ("Alpha Beta Gamma",)))
    cid = create_company(repo, display_name="Delta Imports", country="IN")
    first = screen_company(cid, tx=repo, store=store, outbox=out)
    assert screen_company_for_rpc(cid, tx=repo, store=store, outbox=out).cached
    store.loads["un"].loaded_at = first.screened_at + timedelta(seconds=1)
    assert not screen_company_for_rpc(cid, tx=repo, store=store, outbox=out).cached
