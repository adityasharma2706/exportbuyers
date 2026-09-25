"""M12 tests (no database, network or S3): parsing, validation, relations and end-to-end loads
into MemoryHsStore through the M08 connector framework."""
from __future__ import annotations

from typing import Any, Iterable

import pytest

import kp.m08_sources.connector as connector_mod
from kp.m08_sources import (
    FetchRequest,
    MemoryRawIndex,
    MemoryRawStore,
    RawItem,
    register_entries_loader,
    set_source_loader_for_testing,
    validate_entry,
)
from kp.m12_hs import (
    EMBEDDING_DIM,
    EV_NOMENCLATURE_VERSION_LOADED,
    CorrelationLoader,
    CorrelationPair,
    DgftItcHsLoader,
    HsLoadError,
    MemoryHsStore,
    WcoHsLoader,
    derive_relations,
    itchs_version,
    normalize_code,
    normalize_policy,
    read_tables,
)


def _source(id_: str) -> Any:
    return validate_entry({
        "id": id_, "source_type": "nomenclature", "can_store": True, "can_display": True, "can_export": True,
        "retention_days": None, "attribution_text": f"Source: {id_}", "personal_data_class": "none",
        "allowed_regions": ["*"], "status": "active", "notes": None,
    })


@pytest.fixture(autouse=True)
def _isolation(monkeypatch: pytest.MonkeyPatch) -> Iterable[None]:
    monkeypatch.setattr(connector_mod, "is_budget_exceeded", lambda vendor: False)
    monkeypatch.setattr(connector_mod, "assert_vendor_budget", lambda vendor: None)
    monkeypatch.setattr(connector_mod, "record_cost", lambda **kw: None)
    set_source_loader_for_testing(register_entries_loader([_source("nomenclature.wco.hs"),
                                                           _source("nomenclature.in.itchs")]))
    yield
    set_source_loader_for_testing(None)


def _fake_embed(texts: list[str], **_: Any) -> list[list[float]]:
    return [[0.001 * (i + 1)] * EMBEDDING_DIM for i, _t in enumerate(texts)]


def _with_body(cls: type, body: bytes) -> type:
    class Fixed(cls):  # type: ignore[misc, valid-type]
        def fetch(self, req: FetchRequest) -> Iterable[RawItem]:
            yield RawItem(body=body, content_type="text/csv", url=str(req.params["url"]))
    return Fixed


def _kw() -> dict[str, Any]:
    return {"store": MemoryRawStore(), "index": MemoryRawIndex()}


HS2022_CSV = b"""WCO Harmonized System 2022
Heading/Subheading,Description
01,Live animals
01.01,"Live horses, asses, mules and hinnies"
0101.21,Pure-bred breeding animals
0101.29,Other
0101.3,Asses (5-digit grouping skipped)
"""

HS2027_CSV = b"""HS code,Description
01,Live animals
01.01,"Live horses, asses, mules and hinnies"
0101.21,Pure-bred breeding animals
0101.31,Racing horses
0101.39,Other horses
"""

ITCHS_CSV = b"""ITC(HS) Code,Description,Export Policy,Policy Condition
01012100,Pure-bred breeding horses,Free,
01012910,Horses for polo,Restricted,Exportable under licence
01012990,Other,STE,Through notified agencies
"""

CORR_CSV = b"""HS 2022,HS 2027
0101.21,0101.21
0101.29,0101.31
,0101.39
"""


def test_code_and_policy_normalization() -> None:
    assert normalize_code("0101.21") == "010121"
    assert normalize_code("ex 0101.21") == "010121"
    assert normalize_code(10121) == "010121"
    assert normalize_code(101.2) == "010120"
    assert normalize_code(1012100) == "01012100"
    assert normalize_code("0101.3") is None
    assert normalize_code("Description") is None
    assert normalize_policy("State Trading Enterprise") == "ste"
    assert normalize_policy(" Free ") == "free"
    assert normalize_policy("") is None
    with pytest.raises(Exception):
        normalize_policy("sometimes")
    assert itchs_version(2022) == "ITCHS2022"


def test_pdf_is_rejected() -> None:
    with pytest.raises(HsLoadError):
        read_tables(b"%PDF-1.7 ...")


def test_relations_from_cardinality() -> None:
    rows = derive_relations("HS2022", "HS2027", [
        CorrelationPair("010121", "010121"),
        CorrelationPair("010129", "010131"), CorrelationPair("010129", "010139"),
        CorrelationPair("020110", "020100"), CorrelationPair("020120", "020100"),
    ])
    rel = {(r.from_code, r.to_code): r.relation for r in rows}
    assert rel[("010121", "010121")] == "1:1"
    assert rel[("010129", "010131")] == "1:n"
    assert rel[("020110", "020100")] == "n:1"


def test_end_to_end_loads() -> None:
    store = MemoryHsStore()
    res = _with_body(WcoHsLoader, HS2022_CSV)("HS2022", **_kw()).load(
        "https://example.org/hs2022.csv", store, embed_fn=_fake_embed)
    assert res.codes == 4 and res.embedded == 4 and res.made_current
    assert store.versions == {"HS2022": True}
    assert store.codes["HS2022"]["010121"].parent_code == "0101"

    itc = _with_body(DgftItcHsLoader, ITCHS_CSV)("2022", **_kw()).load(
        "https://www.dgft.gov.in/itchs.csv", store, embed_fn=_fake_embed)
    assert itc.version == "ITCHS2022" and itc.codes == 3
    line = store.codes["ITCHS2022"]["01012910"]
    assert line.export_policy == "restricted" and line.policy_conditions == "Exportable under licence"
    assert line.policy_source_url == "https://www.dgft.gov.in/itchs.csv"

    # Reloading reuses stored embeddings.
    again = _with_body(WcoHsLoader, HS2022_CSV)("HS2022", **_kw()).load(
        "https://example.org/hs2022.csv", store, embed_fn=_fake_embed)
    assert again.embeddings_reused == 4 and again.embedded == 0

    _with_body(WcoHsLoader, HS2027_CSV)("HS2027", **_kw()).load(
        "https://example.org/hs2027.csv", store, embed_fn=_fake_embed)
    # is_current moves within the HS family only; ITC-HS stays current.
    assert store.versions == {"HS2022": False, "HS2027": True, "ITCHS2022": True}
    assert (EV_NOMENCLATURE_VERSION_LOADED, {"version": "HS2027"}) in store.events

    n = _with_body(CorrelationLoader, CORR_CSV)("HS2022", "HS2027", **_kw()).load(
        "https://example.org/corr.csv", store)
    assert n == 3
    rel = {(r.from_code, r.to_code): r.relation for r in store.correlations[("HS2022", "HS2027")]}
    assert rel == {("010121", "010121"): "1:1", ("010129", "010131"): "1:n", ("010129", "010139"): "1:n"}


def test_orphan_national_lines_fail_the_load() -> None:
    store = MemoryHsStore()
    _with_body(WcoHsLoader, HS2022_CSV)("HS2022", **_kw()).load(
        "https://example.org/hs2022.csv", store, embed_fn=_fake_embed)
    orphan = ITCHS_CSV + b"99019000,Orphan line,Free,\n"
    with pytest.raises(HsLoadError) as ei:
        _with_body(DgftItcHsLoader, orphan)("2022", **_kw()).load(
            "https://www.dgft.gov.in/itchs.csv", store, embed_fn=_fake_embed)
    assert any("990190" in p for p in (ei.value.details or {}).get("problems", []))
    assert "ITCHS2022" not in store.codes


def test_itchs_requires_hs_version() -> None:
    with pytest.raises(HsLoadError):
        _with_body(DgftItcHsLoader, ITCHS_CSV)("2022", **_kw()).load(
            "https://www.dgft.gov.in/itchs.csv", MemoryHsStore(), embed_fn=_fake_embed)
