"""M21 tests: parsing, HS inference, Parquet + DuckDB aggregation and the end-to-end weekly run
(local drop directory, local lake, in-memory raw storage and evidence repo; no network, no database)."""
from __future__ import annotations

import gzip
import json
from contextlib import nullcontext
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import pytest

import kp.m08_sources.connector as connector_mod
from kp.m02_queue import JobMeta, NonRetryable
from kp.m08_sources import (
    MemoryRawIndex,
    MemoryRawStore,
    register_entries_loader,
    set_source_loader_for_testing,
    validate_entry,
)
from kp.m09_evidence import MemoryEvidenceRepo, get_assertions, set_suppression_checker
from kp.m19_classifiers import CuratedList, set_curated_list_for_testing
from kp.m21_customs_us import (
    ACTIVITY_ATTRIBUTE,
    BolRow,
    ColumnMap,
    CustomsDeps,
    CustomsUsConfig,
    DeliveryMissing,
    DropVendor,
    HeadingAggregate,
    HeadingIndex,
    HsInferer,
    IngestWeekPayload,
    IsoWeek,
    ParquetLake,
    ParseStats,
    Supplier,
    Window,
    aggregate,
    handle_ingest,
    infer,
    ingest_week,
    key_row,
    merge_aggregates,
    parse_config,
    parse_vendor_file,
    set_customs_config_for_testing,
    set_deps_for_testing,
    source_id_for,
)

VENDOR = "testvendor"
SOURCE_ID = source_id_for(VENDOR)
WEEK = IsoWeek(2026, 38)   # 2026-09-14 .. 2026-09-20
NOW = datetime(2026, 9, 22, 6, 0, tzinfo=timezone.utc)

SOURCES = [validate_entry({
    "id": SOURCE_ID, "source_type": "customs", "can_store": True, "can_display": True, "can_export": False,
    "retention_days": None, "attribution_text": "US customs records (test vendor)", "personal_data_class": "none",
    "allowed_regions": ["US"], "status": "active",
})]

HEADINGS = [
    ("0306", "Crustaceans, frozen shrimps and prawns", [1.0, 0.0, 0.0, 0.0]),
    ("7208", "Flat-rolled products of iron or non-alloy steel, hot-rolled", [0.0, 1.0, 0.0, 0.0]),
    ("6109", "T-shirts, singlets and vests, knitted cotton", [0.0, 0.0, 1.0, 0.0]),
]


def fake_embed(texts: list[str]) -> list[list[float]]:
    out: list[list[float]] = []
    for t in texts:
        low = t.lower()
        if "shrimp" in low or "prawn" in low:
            out.append([1.0, 0.0, 0.0, 0.0])
        elif "steel" in low:
            out.append([0.0, 1.0, 0.0, 0.0])
        else:
            out.append([0.0, 0.0, 0.0, 1.0])
    return out


class _Budget:
    def is_exceeded(self, vendor: str) -> bool:
        return False

    def assert_budget(self, vendor: str) -> None:
        return None

    def record(self, **kw: Any) -> None:
        return None


class FakeQueueConn:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    def execute(self, sql: str, params: Any = None) -> Any:
        self.calls.append((sql, params))

        class R:
            def fetchone(self_inner) -> Any:
                return (params[0],) if params else None
        return R()


@pytest.fixture(autouse=True)
def _isolated(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    b = _Budget()
    monkeypatch.setattr(connector_mod, "is_budget_exceeded", b.is_exceeded)
    monkeypatch.setattr(connector_mod, "assert_vendor_budget", b.assert_budget)
    monkeypatch.setattr(connector_mod, "record_cost", b.record)
    set_source_loader_for_testing(register_entries_loader(SOURCES))
    set_suppression_checker(None)
    set_curated_list_for_testing(CuratedList.build([], []))
    yield
    set_deps_for_testing(None)
    set_customs_config_for_testing(None)
    set_curated_list_for_testing(None)
    set_source_loader_for_testing(None)


CSV_WEEK = (
    "Bill of Lading Number,Actual Arrival Date,Consignee,Consignee Address,Shipper,Country of Origin,"
    "HS Code,Product Description,Weight,Weight Unit,TEU\n"
    "BOL1,2026-09-15,ACME FOODS INC,\"1 Harbor Rd, Newark NJ 07105\",Coastal Seafoods Pvt Ltd,India,030617,"
    "FROZEN SHRIMP,1000,KG,1\n"
    "BOL2,09/16/2026,\"Acme Foods, Inc.\",\"1 Harbor Rd, Newark NJ 07105\",Mekong Aqua Co,VNM,,"
    "FROZEN SHRIMP PD,500,LB,0.5\n"
    "BOL3,2026-09-16,TO ORDER,,Someone,CN,030617,FROZEN SHRIMP,10,KG,\n"
    "BOL4,2026-09-17,Beta Steel LLC,\"9 Mill St, Gary IN 46402\",Shanghai Metals Co Ltd,CN,7208.51,"
    "HOT ROLLED STEEL COILS,20000,KG,2\n"
    "BOL5,2026-09-18,Beta Steel LLC,\"9 Mill St, Gary IN 46402\",Unknown Exporter,DE,,MISC GOODS,50,KG,\n"
)


def _drop(tmp_path: Path, week: IsoWeek = WEEK, body: str = CSV_WEEK, gz: bool = False) -> Path:
    root = tmp_path / "drop"
    d = root / f"week={week}"
    d.mkdir(parents=True, exist_ok=True)
    if gz:
        (d / "bol.csv.gz").write_bytes(gzip.compress(body.encode()))
    else:
        (d / "bol.csv").write_text(body, encoding="utf-8")
    (d / "_SUCCESS").write_text("")
    return root


def _deps(tmp_path: Path, repo: MemoryEvidenceRepo, queue: FakeQueueConn, drop: Path | None = None) -> CustomsDeps:
    return CustomsDeps(
        vendor=DropVendor(VENDOR, str(drop or tmp_path / "drop")),
        lake=ParquetLake(str(tmp_path / "lake")),
        heading_index=lambda: HeadingIndex(HEADINGS),
        embed_fn=fake_embed,
        tx=lambda: nullcontext(repo),
        queue_tx=lambda: nullcontext(queue),
        raw_store=MemoryRawStore(),
        raw_index=MemoryRawIndex(),
        curated=CuratedList.build([], []),
        config=CustomsUsConfig(vendor=VENDOR, drop_uri=str(drop or tmp_path / "drop")),
    )


# ---- units ------------------------------------------------------------------------------------------

def test_iso_week() -> None:
    assert str(IsoWeek.parse("2026-W38")) == "2026-38" == str(IsoWeek.parse("2026-38"))
    assert WEEK.start == date(2026, 9, 14) and WEEK.end == date(2026, 9, 20)
    assert WEEK.label() == "2026-W38"
    assert IsoWeek.last_complete(NOW) == WEEK
    with pytest.raises(Exception):
        IsoWeek(2026, 54)


def test_parse_vendor_file_maps_columns_and_rejects_placeholders() -> None:
    stats = ParseStats()
    rows = list(parse_vendor_file(CSV_WEEK.encode(), "text/csv", ColumnMap(), stats))
    assert [r.bol_id for r in rows] == ["BOL1", "BOL2", "BOL4", "BOL5"]
    assert stats.rejected == 1 and stats.reasons == {"no_consignee": 1}
    r1, r2 = rows[0], rows[1]
    assert r1.arrival_date == date(2026, 9, 15) and r1.shipper_country == "IN" and r1.hs_code == "030617"
    assert r2.arrival_date == date(2026, 9, 16) and r2.shipper_country == "VN" and r2.hs_code is None
    assert r2.weight_kg == pytest.approx(500 * 0.45359237)
    assert rows[2].hs_code == "720851"


def test_parse_jsonl_gzip() -> None:
    body = gzip.compress("\n".join(json.dumps(o) for o in [
        {"bol": "X1", "arrival_date": "2026-09-15", "importer": "Gamma Imports LLC", "hts": "6109.10",
         "weight_kg": 12.5, "shipper_country": "BD"},
    ]).encode())
    rows = list(parse_vendor_file(body, "application/x-ndjson+gzip"))
    assert rows[0].consignee_name == "Gamma Imports LLC" and rows[0].hs_code == "610910"
    assert rows[0].weight_kg == 12.5 and rows[0].shipper_country == "BD"


def test_missing_required_columns_is_an_error() -> None:
    with pytest.raises(Exception):
        list(parse_vendor_file(b"foo,bar\n1,2\n", "text/csv"))


def test_inference_keyword_and_vector_with_threshold() -> None:
    idx = HeadingIndex(HEADINGS)
    good = infer(idx, "frozen shrimp pd", fake_embed(["frozen shrimp"])[0])
    assert good.heading == "0306" and good.confidence >= 0.6 and good.method == "keyword+vector"
    none = infer(idx, "misc goods", fake_embed(["misc goods"])[0])
    assert none.heading is None
    rows = [BolRow(bol_id="a", arrival_date=date(2026, 9, 15), consignee_name="X", description="Frozen shrimp"),
            BolRow(bol_id="b", arrival_date=date(2026, 9, 15), consignee_name="X", hs_code="720851"),
            BolRow(bol_id="c", arrival_date=date(2026, 9, 15), consignee_name="X", description="misc goods")]
    declared, inferred, dropped = HsInferer(idx, fake_embed).apply(rows)
    assert (declared, inferred, dropped) == (1, 1, 1)
    assert rows[1].hs_heading == "7208" and rows[1].hs_method == "declared"


def test_pii_descriptions_are_not_embedded() -> None:
    seen: list[str] = []

    def spy(texts: list[str]) -> list[list[float]]:
        seen.extend(texts)
        return fake_embed(texts)

    rows = [BolRow(bol_id="a", arrival_date=date(2026, 9, 15), consignee_name="X",
                   description="frozen shrimp contact john.doe@example.com")]
    HsInferer(HeadingIndex(HEADINGS), spy).apply(rows)
    assert seen == []
    assert rows[0].hs_heading == "0306" and rows[0].hs_method == "keyword"


def test_merge_aggregates() -> None:
    a = HeadingAggregate("0306", 2, 100.0, 1.0, {"IN": 2}, [Supplier("Coastal Seafoods Pvt Ltd", "IN", 2)],
                         date(2026, 9, 1), 2, 1.0)
    b = HeadingAggregate("0306", 1, 50.0, 0.0, {"IN": 1, "VN": 1}, [Supplier("COASTAL SEAFOODS PVT. LTD.", "IN", 1)],
                         date(2026, 9, 10), 2, 0.7)
    m = merge_aggregates([a, b])
    assert m.shipments_12m == 3 and m.volume_kg_12m == 150.0 and m.origins == {"IN": 3, "VN": 1}
    assert m.last_seen == date(2026, 9, 10) and m.row_count == 4
    assert len(m.top_suppliers) == 1 and m.top_suppliers[0].shipments == 3
    assert m.mean_hs_confidence == pytest.approx(0.85)


def test_aggregation_window_and_redelivery(tmp_path: Path) -> None:
    lake = ParquetLake(str(tmp_path / "lake"))
    idx = HeadingIndex(HEADINGS)

    def rows(week: IsoWeek, specs: list[tuple[str, date, float]]) -> list[BolRow]:
        out = [key_row(BolRow(bol_id=b, arrival_date=d, consignee_name="Delta Seafood Corp",
                              shipper_name="Coastal Seafoods Pvt Ltd", shipper_country="IN", hs_code="030617",
                              weight_kg=kg), week) for b, d, kg in specs]
        HsInferer(idx, fake_embed).apply(out)
        return out

    old_week = IsoWeek(2025, 30)                                      # > 12 months before WEEK's end
    lake.write_part(old_week, 0, rows(old_week, [("OLD", date(2025, 7, 22), 999.0)]))
    w1 = IsoWeek(2026, 30)
    lake.write_part(w1, 0, rows(w1, [("B1", date(2026, 7, 21), 100.0)]))
    # B1 is re-delivered (corrected weight) in WEEK; the later delivery wins.
    lake.write_part(WEEK, 0, rows(WEEK, [("B1", date(2026, 7, 21), 150.0), ("B2", date(2026, 9, 15), 10.0)]))
    groups = aggregate(lake, WEEK)
    assert len(groups) == 1
    (h,) = groups[0].headings
    assert h.hs_heading == "0306" and h.shipments_12m == 2 and h.volume_kg_12m == pytest.approx(160.0)
    assert h.last_seen == date(2026, 9, 15) and h.origins == {"IN": 2}
    assert h.top_suppliers[0].name == "Coastal Seafoods Pvt Ltd"
    w = Window.for_week(WEEK)
    assert w.as_of == date(2026, 9, 20)


def test_quiet_consignee_gets_zero_aggregate_with_last_seen(tmp_path: Path) -> None:
    lake = ParquetLake(str(tmp_path / "lake"))
    wk = IsoWeek(2025, 20)
    r = key_row(BolRow(bol_id="Q1", arrival_date=date(2025, 5, 14), consignee_name="Quiet Importers LLC",
                       hs_code="720851", weight_kg=5.0), wk)
    HsInferer(HeadingIndex(HEADINGS), fake_embed).apply([r])
    lake.write_part(wk, 0, [r])
    (g,) = aggregate(lake, WEEK)
    (h,) = g.headings
    assert h.shipments_12m == 0 and h.volume_kg_12m == 0 and h.origins == {} and h.last_seen == date(2025, 5, 14)


# ---- end to end ---------------------------------------------------------------------------------------

def test_weekly_run_writes_only_aggregates(tmp_path: Path) -> None:
    repo, queue = MemoryEvidenceRepo(), FakeQueueConn()
    _drop(tmp_path)
    run = ingest_week(WEEK, _deps(tmp_path, repo, queue), run_id="run-1", now=NOW)
    assert run.files == 1 and run.rows_landed == 4 and run.rows_rejected == 1
    assert (run.hs_declared, run.hs_inferred, run.hs_dropped) == (2, 1, 1)
    assert len(run.parquet_parts) == 1 and run.parquet_parts[0].endswith("week=2026-38/part-0000.parquet")
    assert run.companies_resolved == 2 and run.assertions_written == 2 and run.group_errors == 0

    assert len(repo.companies) == 2
    assert all(c.country == "US" for c in repo.companies.values())
    acts = []
    for cid in repo.companies:
        acts.extend(get_assertions(cid, [ACTIVITY_ATTRIBUTE], tx=repo))
    by_heading = {a.value["hs_heading"]: a for a in acts}
    assert set(by_heading) == {"0306", "7208"}
    shrimp = by_heading["0306"]
    assert shrimp.value["shipments_12m"] == 2
    assert shrimp.value["volume_kg_12m"] == pytest.approx(1000 + 500 * 0.45359237, rel=1e-6)
    assert shrimp.value["origins"] == {"IN": 1, "VN": 1}
    assert shrimp.value["last_seen"] == "2026-09-16"
    assert shrimp.source_id == SOURCE_ID and shrimp.source_ref["batch_week"] == "2026-W38"
    assert shrimp.source_ref["row_count"] == 2 and shrimp.region == "US"
    assert {s["name"] for s in shrimp.value["top_suppliers"]} == {"Coastal Seafoods Pvt Ltd", "Mekong Aqua Co"}
    steel = by_heading["7208"]
    assert steel.value["shipments_12m"] == 1 and steel.value["origins"] == {"CN": 1}
    # Nothing BOL-level from the customs source reaches the evidence store.
    all_from_source = [a for a in repo.assertions.values() if a.source_id == SOURCE_ID]
    assert len(all_from_source) == 2 and all(a.attribute == ACTIVITY_ATTRIBUTE for a in all_from_source)
    # Coverage recompute enqueued at the end of the run.
    assert run.recompute_job_id and any(p and "m21:run-1" in p for _, p in queue.calls if p)


def test_rerun_replaces_the_week(tmp_path: Path) -> None:
    repo, queue = MemoryEvidenceRepo(), FakeQueueConn()
    _drop(tmp_path, gz=True)
    deps = _deps(tmp_path, repo, queue)
    ingest_week(WEEK, deps, run_id="r1", now=NOW)
    run2 = ingest_week(WEEK, deps, run_id="r2", now=NOW)
    assert len(deps.get_lake().files_for_weeks([WEEK])) == 1
    shrimp = [a for a in repo.assertions.values()
              if a.attribute == ACTIVITY_ATTRIBUTE and a.value["hs_heading"] == "0306" and a.is_active]
    assert len(shrimp) == 1 and shrimp[0].value["shipments_12m"] == 2
    assert run2.rows_landed == 4 and len(repo.companies) == 2


def test_missing_delivery_retries(tmp_path: Path) -> None:
    repo, queue = MemoryEvidenceRepo(), FakeQueueConn()
    (tmp_path / "drop").mkdir()
    with pytest.raises(DeliveryMissing):
        ingest_week(WEEK, _deps(tmp_path, repo, queue), run_id="r", now=NOW)
    assert queue.calls == []


def test_handler_without_vendor_is_non_retryable(tmp_path: Path) -> None:
    set_customs_config_for_testing(CustomsUsConfig(vendor=None))
    set_deps_for_testing(CustomsDeps(config=CustomsUsConfig(vendor=None)))
    meta = JobMeta(job_id="j1", type="m21.ingest_week", queue="knowledge", attempt=1, max_attempts=5,
                   correlation_id="c", actor_ref=None, idempotency_key="k", v=1, enqueued_at=None)
    with pytest.raises(NonRetryable):
        handle_ingest(IngestWeekPayload.model_validate({"week": "2026-W38"}), meta, now=NOW)


def test_config_env_overrides() -> None:
    cfg = parse_config({"vendor": None, "columns": {"bol_id": ["Master BL"]}},
                       env={"CUSTOMS_US_VENDOR": "Acme-Data", "CUSTOMS_US_DROP_URI": "s3://drop/customs/"})
    assert cfg.vendor == "acme-data" and cfg.source_id == "customs.us.acme-data"
    assert cfg.drop_uri == "s3://drop/customs" and cfg.columns == {"bol_id": ("Master BL",)}
