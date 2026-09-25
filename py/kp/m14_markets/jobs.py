"""M14 job wiring (M02 IF-02a / IF-02b), all on the 'knowledge' queue.

- ``m14.comtrade_ingest {mode, reporters?, years?}``  scheduled monthly on the 5th (mode 'monthly':
  the last two years plus their CAGR base years, catching reporters that published since) and
  once a year (mode 'annual': the full seven-year window). Enqueues ``m14.build_rows`` when done.
- ``m14.build_rows {countries?}``                     rebuilds analytics.market_row and enqueues
  "why" jobs for the top 15 per code whose summary is missing.
- ``m14.generate_why {country, hs6, input_hash}``     one summary; also enqueued lazily by the
  serving plane (IF-14a) on the first request for a row outside the top 15.
"""
from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Any, Callable, Literal, Sequence

from pydantic import BaseModel, ConfigDict, Field, field_validator

from kp.m01_platform import KpError, get_logger, get_secret
from kp.m02_queue import JobMeta, NonRetryable, enqueue, register_handler, register_rate_class, register_schedule
from kp.m08_sources import FetchRequest, Record

from .build import build_rows
from .comtrade import RATE_CLASS as COMTRADE_RATE_CLASS
from .comtrade import ComtradeConnector, FlowRow, flow_from_record
from .countries import ISO2_TO_M49, target_countries
from .models import CAGR_YEARS, COUNTRY_RE, ROW_CODE_RE
from .store import MarketStore, PgMarketStore
from .why import generate_why

INGEST_JOB = "m14.comtrade_ingest"
BUILD_JOB = "m14.build_rows"
WHY_JOB = "m14.generate_why"
WHY_RATE_CLASS = "m14.why"
QUEUE = "knowledge"
MONTHLY_CRON = "0 2 5 * *"    # 02:00 on the 5th of every month
ANNUAL_CRON = "0 2 20 3 *"    # 02:00 on 20 March: annual refresh of the whole window [tunable]
FLUSH_EVERY = 20000

_log = get_logger("kp.m14_markets.jobs")
_registered = False
_lock = threading.Lock()
_store_factory: Callable[[], MarketStore] = PgMarketStore
_tx_factory: Callable[[], Any] | None = None


def set_store_factory_for_testing(factory: Callable[[], MarketStore] | None) -> None:
    global _store_factory
    _store_factory = factory or PgMarketStore


def set_tx_factory_for_testing(factory: Callable[[], Any] | None) -> None:
    """``factory()`` returns a context manager yielding an object with ``execute`` (the M02 Tx)."""
    global _tx_factory
    _tx_factory = factory


def _tx() -> Any:
    if _tx_factory is not None:
        return _tx_factory()
    import psycopg

    return psycopg.connect(get_secret("DATABASE_URL"))


def ingest_years(mode: str, today: datetime) -> list[int]:
    last = today.year - 1
    if mode == "annual":
        return list(range(last - CAGR_YEARS - 1, last + 1))
    return sorted({last, last - 1, last - CAGR_YEARS, last - 1 - CAGR_YEARS})


def _countries(v: list[str] | None) -> list[str] | None:
    if v is None:
        return None
    out: list[str] = []
    for c in v:
        c = c.strip().upper()
        if c not in ISO2_TO_M49:
            raise ValueError(f"unknown country {c}")
        if c not in out:
            out.append(c)
    return out


class ComtradeIngestPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["monthly", "annual"] = "monthly"
    reporters: list[str] | None = Field(default=None, max_length=300)
    years: list[int] | None = Field(default=None, max_length=30)

    @field_validator("reporters")
    @classmethod
    def _r(cls, v: list[str] | None) -> list[str] | None:
        return _countries(v)

    @field_validator("years")
    @classmethod
    def _y(cls, v: list[int] | None) -> list[int] | None:
        if v is not None and any(y < 1988 or y > 2100 for y in v):
            raise ValueError("years must be between 1988 and 2100")
        return v


class BuildRowsPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    countries: list[str] | None = Field(default=None, max_length=300)

    @field_validator("countries")
    @classmethod
    def _c(cls, v: list[str] | None) -> list[str] | None:
        return _countries(v)


class GenerateWhyPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    country: str
    hs6: str
    input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")

    @field_validator("country")
    @classmethod
    def _c(cls, v: str) -> str:
        if not COUNTRY_RE.match(v):
            raise ValueError("country must be ISO 3166-1 alpha-2")
        return v

    @field_validator("hs6")
    @classmethod
    def _h(cls, v: str) -> str:
        if not ROW_CODE_RE.match(v):
            raise ValueError("hs6 must be 6 digits or '<4 digits>__'")
        return v


def why_idempotency_key(country: str, code: str, input_hash: str) -> str:
    return f"{country}:{code}:{input_hash}"


def enqueue_why_jobs(items: Sequence[tuple[str, str, str]]) -> int:
    """One ``m14.generate_why`` per (country, code, hash); re-enqueueing the same hash is a no-op."""
    n = 0
    with _tx() as tx:
        for country, code, h in items:
            enqueue(tx, type=WHY_JOB, queue=QUEUE, payload={"country": country, "hs6": code, "input_hash": h},
                    idempotency_key=why_idempotency_key(country, code, h), rate_class=WHY_RATE_CLASS)
            n += 1
    return n


def handle_ingest(p: ComtradeIngestPayload, meta: JobMeta) -> None:
    store = _store_factory()
    reporters = p.reporters or list(target_countries())
    years = p.years or ingest_years(p.mode, datetime.now(timezone.utc))
    buffer: list[FlowRow] = []
    total = 0

    def sink(rec: Record) -> None:
        nonlocal total
        f = flow_from_record(rec)
        if f is None:
            return
        buffer.append(f)
        if len(buffer) >= FLUSH_EVERY:
            total += store.upsert_flows(buffer)
            buffer.clear()

    try:
        stats = ComtradeConnector().run(
            FetchRequest(params={"reporters": reporters, "years": years, "freq": "A"},
                         correlation_id=meta.correlation_id),
            sink,
        )
    except KpError as e:
        if e.code in ("POLICY_DENIED", "VALIDATION"):
            raise NonRetryable(str(e)) from e
        raise
    finally:
        if buffer:
            total += store.upsert_flows(buffer)
            buffer.clear()
    _log.info("comtrade ingest finished", extra={"mode": p.mode, "reporters": len(reporters), "years": years,
                                                 "flows": total, "stats": stats.as_dict()})
    if stats.fetched == 0 and stats.errors == 0:
        return  # nothing new; the existing rows stand
    with _tx() as tx:
        enqueue(tx, type=BUILD_JOB, queue=QUEUE, payload={}, idempotency_key=f"after:{meta.job_id}")


def handle_build(p: BuildRowsPayload, meta: JobMeta) -> None:
    try:
        build_rows(_store_factory(), countries=p.countries, enqueue_why=enqueue_why_jobs)
    except KpError as e:
        if e.code == "CONFLICT":
            raise NonRetryable(str(e)) from e
        raise


def handle_why(p: GenerateWhyPayload, meta: JobMeta) -> None:
    out = generate_why(_store_factory(), p.country, p.hs6, expected_hash=p.input_hash,
                       correlation_id=meta.correlation_id)
    _log.info("why summary", extra={"country": p.country, "code": p.hs6, "status": out.status})


def register_market_jobs() -> None:
    """Idempotent: registers handlers, rate classes and the ingest schedules."""
    global _registered
    with _lock:
        if _registered:
            return
        register_rate_class(COMTRADE_RATE_CLASS, 1, 1.0)  # Comtrade API quota [tunable]
        register_rate_class(WHY_RATE_CLASS, 4, 5.0)       # LLM throughput [tunable]
        register_handler(INGEST_JOB, ComtradeIngestPayload, handle_ingest)
        register_handler(BUILD_JOB, BuildRowsPayload, handle_build)
        register_handler(WHY_JOB, GenerateWhyPayload, handle_why)
        register_schedule("m14.comtrade-monthly", MONTHLY_CRON, INGEST_JOB, {"mode": "monthly"}, QUEUE)
        register_schedule("m14.comtrade-annual", ANNUAL_CRON, INGEST_JOB, {"mode": "annual"}, QUEUE)
        _registered = True
