"""M21 weekly run (LLD M21).

1. ``CustomsUsConnector.run`` fetches the week's licensed BOL files, lands them raw (M08) and parses
   them into rows.
2. Rows are keyed (consignee / shipper name normalised with the M17/M18 function), missing HS codes
   get an inferred heading (``hs_infer``), and the week is written as Parquet to
   ``<lake>/week=YYYY-WW/``. A re-run replaces the week.
3. DuckDB SQL aggregates the last 12 months per consignee × heading: ``shipments_12m``,
   ``volume_kg_12m``, ``origins``, ``top_suppliers`` (top 5, company-level) and ``last_seen``.
   Inferred headings with confidence < 0.6 are excluded.
4. For each consignee group: ``resolve(Candidate(name, country='US', address))`` (M18). Groups that
   resolve to the same company are merged, then ``write_assertion(activity_aggregate …,
   source_ref={batch_week, row_count})`` (M09) per heading, and M19's rule-based logistics check runs
   on the company (freight forwarders often appear as consignees). **Only aggregates are written;
   individual BOLs never reach M09.**
5. ``m15.recompute_all`` is enqueued at the end of the run.

``volume_score`` is not computed here; it is derived at projection time (M09).
"""
from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from datetime import datetime, time, timezone
from typing import Any, Callable

from kp.m01_platform import KpError, get_logger, get_secret, new_id, span
from kp.m08_sources import FetchRequest, RawIndex, RawStore, Record
from kp.m09_evidence import AssertionIn, open_repo, write_assertion
from kp.m15_coverage import enqueue_recompute_all
from kp.m18_resolution import Candidate, normalise_name, resolve
from kp.m19_classifiers import CuratedList, classify

from .config import CustomsUsConfig, get_customs_config
from .connector import CustomsUsConnector, bol_row_of
from .hs_infer import EmbedFn, HeadingIndex, HsInferer, pg_heading_index
from .lake import ParquetLake, Window, aggregate
from .models import (
    ACTIVITY_ATTRIBUTE,
    CHUNK_ROWS,
    COUNTRY,
    INGEST_JOB,
    PRODUCER,
    PRODUCER_VERSION,
    TOP_SUPPLIERS,
    BolRow,
    ConsigneeGroup,
    HeadingAggregate,
    IngestRun,
    IsoWeek,
    Supplier,
)
from .vendor import ColumnMap, CustomsUsVendor, DropVendor

_log = get_logger("kp.m21_customs_us.pipeline")

TxFactory = Callable[[], AbstractContextManager[Any]]


class VendorNotConfigured(KpError):
    def __init__(self, what: str) -> None:
        super().__init__("VALIDATION", f"US customs vendor not configured: {what}", {"reason": "vendor_not_configured"})


class DeliveryMissing(KpError):
    """The vendor has not (yet) delivered files for the week; the job retries with backoff."""

    def __init__(self, week: IsoWeek, source_id: str) -> None:
        super().__init__("UPSTREAM_UNAVAILABLE", "No customs delivery for the week yet",
                         {"week": str(week), "source_id": source_id, "reason": "delivery_missing"})


@dataclass
class CustomsDeps:
    vendor: CustomsUsVendor | None = None
    lake: ParquetLake | None = None
    heading_index: Callable[[], HeadingIndex] | None = None
    embed_fn: EmbedFn | None = None
    tx: TxFactory | None = None
    queue_tx: TxFactory | None = None
    raw_store: RawStore | None = None
    raw_index: RawIndex | None = None
    curated: CuratedList | None = None
    config: CustomsUsConfig | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def get_config(self) -> CustomsUsConfig:
        return self.config or get_customs_config()

    def get_vendor(self, vendor_name: str | None = None) -> CustomsUsVendor:
        if self.vendor is not None:
            return self.vendor
        cfg = self.get_config()
        name = vendor_name or cfg.vendor
        if not name:
            raise VendorNotConfigured("set 'vendor' in config/customs_us.yaml or CUSTOMS_US_VENDOR")
        if not cfg.drop_uri:
            raise VendorNotConfigured("set 'drop_uri' in config/customs_us.yaml or CUSTOMS_US_DROP_URI")
        return DropVendor(name, cfg.drop_uri, cost_micros_per_file=cfg.cost_micros_per_file)

    def get_lake(self) -> ParquetLake:
        if self.lake is None:
            self.lake = ParquetLake(self.get_config().lake_uri)
        return self.lake

    def get_heading_index(self) -> HeadingIndex:
        return (self.heading_index or pg_heading_index)()

    def open_tx(self) -> AbstractContextManager[Any]:
        """A transaction for M18/M09/M19 writes (a psycopg connection by default: commits on a clean exit)."""
        return self.tx() if self.tx is not None else open_repo()

    def open_queue_tx(self) -> AbstractContextManager[Any]:
        """A transaction with ``execute`` for M02 ``enqueue`` (the evidence repo is not one)."""
        return self.queue_tx() if self.queue_tx is not None else _pg_conn()


def _pg_conn() -> AbstractContextManager[Any]:
    import psycopg

    conn: AbstractContextManager[Any] = psycopg.connect(get_secret("DATABASE_URL"))
    return conn


# ---- step 2: keying, inference and Parquet --------------------------------------------------------

def key_row(r: BolRow, week: IsoWeek) -> BolRow:
    r.consignee_key = normalise_name(r.consignee_name) or ""
    r.shipper_key = normalise_name(r.shipper_name) if r.shipper_name else ""
    r.batch_week = str(week)
    return r


class _LakeSink:
    """M08 record sink: buffers BOL rows and flushes them in chunks to Parquet after HS inference."""

    def __init__(self, lake: ParquetLake, week: IsoWeek, inferer: Callable[[], HsInferer], run: IngestRun) -> None:
        self.lake = lake
        self.week = week
        self._make_inferer = inferer
        self._inferer: HsInferer | None = None
        self.run = run
        self.buffer: list[BolRow] = []
        self.part = 0
        self.cleared = False

    def __call__(self, rec: Record) -> None:
        row = bol_row_of(rec)
        if row is None:
            return
        self.buffer.append(key_row(row, self.week))
        if len(self.buffer) >= CHUNK_ROWS:
            self.flush()

    def flush(self) -> None:
        if not self.buffer:
            return
        if self._inferer is None:
            self._inferer = self._make_inferer()
        declared, inferred, dropped = self._inferer.apply(self.buffer)
        self.run.hs_declared += declared
        self.run.hs_inferred += inferred
        self.run.hs_dropped += dropped
        if not self.cleared:
            # Only replace an existing week once there is new data to replace it with.
            self.lake.clear_week(self.week)
            self.cleared = True
        self.run.parquet_parts.append(self.lake.write_part(self.week, self.part, self.buffer))
        self.run.rows_landed += len(self.buffer)
        self.part += 1
        self.buffer = []


def land_week(week: IsoWeek, run: IngestRun, deps: CustomsDeps, vendor: CustomsUsVendor) -> None:
    cfg = deps.get_config()
    connector = CustomsUsConnector.for_vendor(vendor, columns=ColumnMap(cfg.columns), store=deps.raw_store,
                                              index=deps.raw_index)
    index_holder: dict[str, HeadingIndex] = {}

    def make_inferer() -> HsInferer:
        if "i" not in index_holder:
            index_holder["i"] = deps.get_heading_index()
        return HsInferer(index_holder["i"], deps.embed_fn, job_type=INGEST_JOB)

    sink = _LakeSink(deps.get_lake(), week, make_inferer, run)
    stats = connector.run(FetchRequest(params={"week": str(week)}, correlation_id=run.run_id), sink)
    sink.flush()
    run.files = stats.fetched
    run.rows_rejected = connector.parse_stats.rejected
    if stats.fetched == 0:
        raise DeliveryMissing(week, connector.source.id)
    if stats.errors and stats.errors >= stats.fetched:
        raise KpError("VALIDATION", "Every customs file in the delivery failed to parse",
                      {"week": str(week), "files": stats.fetched})
    if stats.budget_stopped:
        raise KpError("UPSTREAM_UNAVAILABLE", "Vendor budget exhausted during the customs run",
                      {"week": str(week), "reason": "budget_exceeded"})


# ---- step 4: resolve, merge, write ----------------------------------------------------------------

def merge_aggregates(aggs: list[HeadingAggregate]) -> HeadingAggregate:
    """Combines one heading's aggregates from several consignee groups of the same company."""
    if len(aggs) == 1:
        return aggs[0]
    origins: dict[str, int] = {}
    suppliers: dict[str, Supplier] = {}
    rows = sum(a.row_count for a in aggs)
    for a in aggs:
        for cc, n in a.origins.items():
            origins[cc] = origins.get(cc, 0) + n
        for s in a.top_suppliers:
            k = normalise_name(s.name) or s.name.casefold()
            prev = suppliers.get(k)
            suppliers[k] = Supplier(name=prev.name if prev else s.name, country=(prev.country if prev else None) or s.country,
                                    shipments=(prev.shipments if prev else 0) + s.shipments)
    top = sorted(suppliers.values(), key=lambda s: (-s.shipments, s.name))[:TOP_SUPPLIERS]
    return HeadingAggregate(
        hs_heading=aggs[0].hs_heading,
        shipments_12m=sum(a.shipments_12m for a in aggs),
        volume_kg_12m=sum(a.volume_kg_12m for a in aggs),
        teu_12m=sum(a.teu_12m for a in aggs),
        origins=origins,
        top_suppliers=top,
        last_seen=max(a.last_seen for a in aggs),
        row_count=rows,
        mean_hs_confidence=(sum(a.mean_hs_confidence * a.row_count for a in aggs) / rows) if rows else 0.0,
    )


def _resolve_groups(groups: list[ConsigneeGroup], run: IngestRun, deps: CustomsDeps,
                    source_id: str) -> dict[str, list[ConsigneeGroup]]:
    by_company: dict[str, list[ConsigneeGroup]] = {}
    for g in groups:
        try:
            with deps.open_tx() as tx:
                res = resolve(Candidate(name=g.name[:500], country=COUNTRY, address=(g.address or None) and g.address[:2000],
                                        source_id=source_id), tx=tx)
        except (KpError, ValueError) as e:  # pydantic's ValidationError is a ValueError
            run.group_errors += 1
            _log.warning("consignee resolution failed",
                         extra={"code": getattr(e, "code", type(e).__name__), "consignee_key": g.consignee_key})
            continue
        if res.company_id is None:
            run.companies_suppressed += 1
            continue
        run.companies_created += int(res.created)
        by_company.setdefault(str(res.company_id), []).append(g)
    run.companies_resolved = len(by_company)
    return by_company


def _write_company(company_id: str, groups: list[ConsigneeGroup], week: IsoWeek, w: Window, run: IngestRun,
                   deps: CustomsDeps, source_id: str, now: datetime) -> None:
    per_heading: dict[str, list[HeadingAggregate]] = {}
    for g in groups:
        for a in g.headings:
            per_heading.setdefault(a.hs_heading, []).append(a)
    observed_at = datetime.combine(w.as_of, time(23, 59, 59), tzinfo=timezone.utc)
    with deps.open_tx() as tx:
        for heading in sorted(per_heading):
            agg = merge_aggregates(per_heading[heading])
            aid = write_assertion(AssertionIn(
                subject_id=company_id,
                attribute=ACTIVITY_ATTRIBUTE,
                value=agg.value(w.start_12m, w.as_of),
                source_id=source_id,
                source_ref={"batch_week": week.label(), "row_count": agg.row_count, "run_id": run.run_id,
                            "consignee_groups": len(per_heading[heading])},
                observed_at=observed_at,
                checked_at=now,
                confidence=agg.confidence(),
                region=COUNTRY,
                producer=PRODUCER,
                producer_version=PRODUCER_VERSION,
            ), tx=tx)
            if aid is None:
                run.assertions_suppressed += 1
            else:
                run.assertions_written += 1
        # Rules-only (no evidence texts → no LLM call): flags forwarders / NVOCCs acting as consignees.
        try:
            classify(company_id, [], tx=tx, curated=deps.curated, job_type=INGEST_JOB, correlation_id=run.run_id)
        except KpError as e:
            _log.warning("logistics rule check failed", extra={"company_id": company_id, "code": e.code})


def write_aggregates(groups: list[ConsigneeGroup], week: IsoWeek, run: IngestRun, deps: CustomsDeps,
                     source_id: str, now: datetime | None = None) -> None:
    w = Window.for_week(week)
    t = now or datetime.now(timezone.utc)
    run.consignee_groups = len(groups)
    for company_id, gs in _resolve_groups(groups, run, deps, source_id).items():
        try:
            _write_company(company_id, gs, week, w, run, deps, source_id, t)
        except KpError as e:
            run.group_errors += 1
            _log.warning("writing customs aggregates failed", extra={"company_id": company_id, "code": e.code})


# ---- the run --------------------------------------------------------------------------------------

def ingest_week(week: IsoWeek, deps: CustomsDeps | None = None, *, vendor_name: str | None = None,
                skip_fetch: bool = False, run_id: str | None = None, now: datetime | None = None) -> IngestRun:
    d = deps or CustomsDeps()
    vendor = d.get_vendor(vendor_name)
    source_id = CustomsUsConnector.for_vendor(vendor, store=d.raw_store, index=d.raw_index).source.id
    run = IngestRun(run_id=run_id or new_id(), week=str(week), source_id=source_id)
    with span(INGEST_JOB, {"week": str(week), "source_id": source_id, "run_id": run.run_id}):
        if not skip_fetch:
            land_week(week, run, d, vendor)
        groups = aggregate(d.get_lake(), week)
        write_aggregates(groups, week, run, d, source_id, now)
        if groups and run.group_errors >= len(groups):
            raise KpError("INTERNAL", "Every consignee group failed; not recomputing coverage",
                          {"week": str(week), "groups": len(groups)})
        with d.open_queue_tx() as tx:
            run.recompute_job_id = enqueue_recompute_all(tx, f"m21:{run.run_id}", countries=[COUNTRY],
                                                         reason=f"m21 {source_id} {week.label()}")
    _log.info("customs week ingested", extra={"run": run.summary()})
    return run
