"""M15 job wiring (M02 IF-02a / IF-02b / IF-02c), all on the 'knowledge' queue.

- ``m15.recompute_cell {country, heading}``  enqueued on EV-05 DiscoveryCompleted, debounced 5 minutes:
  every event for the same cell inside one 5-minute window maps to the same idempotency key and one
  job that runs at the end of the window.
- ``m15.recompute_all {countries?}``         nightly at 02:00 IST (20:30 UTC; M02 cron is UTC), and
  enqueued by M21 at the end of each customs run via ``enqueue_recompute_all``.
"""
from __future__ import annotations

import math
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from pydantic import BaseModel, ConfigDict, Field, field_validator

from kp.m01_platform import get_logger, get_secret
from kp.m02_queue import EventMeta, JobMeta, NonRetryable, enqueue, register_handler, register_schedule, subscribe

from .matrix import recompute_all, recompute_cell
from .rules import validate_country, validate_heading
from .store import CoverageStore, PgCoverageStore

RECOMPUTE_CELL_JOB = "m15.recompute_cell"
RECOMPUTE_ALL_JOB = "m15.recompute_all"
QUEUE = "knowledge"
# EV-05 DiscoveryCompleted {country, hsHeading, newCompanies, runId, degraded?}, emitted by M20.
EV_DISCOVERY_COMPLETED = "discovery.completed"
EV05_HANDLER = "m15_recompute_cell"
DEBOUNCE_SECONDS = 300                 # [tunable]
NIGHTLY_CRON = "30 20 * * *"           # 02:00 IST == 20:30 UTC the previous day
NIGHTLY_SCHEDULE = "m15.recompute-nightly"

_log = get_logger("kp.m15_coverage.jobs")
_registered = False
_lock = threading.Lock()
_store_factory: Callable[[], CoverageStore] = PgCoverageStore
_tx_factory: Callable[[], Any] | None = None


def set_store_factory_for_testing(factory: Callable[[], CoverageStore] | None) -> None:
    global _store_factory
    _store_factory = factory or PgCoverageStore


def set_tx_factory_for_testing(factory: Callable[[], Any] | None) -> None:
    """``factory()`` returns a context manager yielding an object with ``execute`` (the M02 Tx)."""
    global _tx_factory
    _tx_factory = factory


def _tx() -> Any:
    if _tx_factory is not None:
        return _tx_factory()
    import psycopg

    return psycopg.connect(get_secret("DATABASE_URL"))


class RecomputeCellPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    country: str
    heading: str

    @field_validator("country")
    @classmethod
    def _c(cls, v: str) -> str:
        return validate_country(v)

    @field_validator("heading")
    @classmethod
    def _h(cls, v: str) -> str:
        return validate_heading(v)


class RecomputeAllPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    countries: list[str] | None = Field(default=None, max_length=300)
    reason: str | None = Field(default=None, max_length=200)

    @field_validator("countries")
    @classmethod
    def _cs(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else sorted({validate_country(c) for c in v})


def debounce_window(now: datetime) -> tuple[int, datetime]:
    """(window index, window end) for the 5-minute debounce bucket containing ``now``."""
    ts = now.timestamp()
    idx = int(math.floor(ts / DEBOUNCE_SECONDS))
    end = datetime.fromtimestamp((idx + 1) * DEBOUNCE_SECONDS, tz=timezone.utc)
    return idx, end


def cell_idempotency_key(country: str, heading: str, window: int) -> str:
    return f"{country}:{heading}:{window}"


def enqueue_recompute_cell(tx: Any, country: str, heading: str, *, now: datetime | None = None) -> str:
    """Debounced: one job per cell per 5-minute window, running at the window's end."""
    c = validate_country(country)
    h = validate_heading(heading)
    idx, end = debounce_window(now or datetime.now(timezone.utc))
    return enqueue(tx, type=RECOMPUTE_CELL_JOB, queue=QUEUE, payload={"country": c, "heading": h},
                   idempotency_key=cell_idempotency_key(c, h, idx), run_at=end)


def enqueue_recompute_all(tx: Any, idempotency_key: str, *, countries: list[str] | None = None,
                          reason: str | None = None) -> str:
    """For M21 at the end of a run: ``enqueue_recompute_all(tx, f"m21:{run_id}")``."""
    payload: dict[str, Any] = {}
    if countries is not None:
        payload["countries"] = sorted({validate_country(c) for c in countries})
    if reason is not None:
        payload["reason"] = reason
    return enqueue(tx, type=RECOMPUTE_ALL_JOB, queue=QUEUE, payload=payload, idempotency_key=idempotency_key)


def parse_discovery_completed(payload: Any) -> tuple[str, str] | None:
    """(country, heading) from an EV-05 payload, or None when it does not name a valid cell."""
    if not isinstance(payload, Mapping):
        return None
    country = payload.get("country")
    heading = payload.get("hsHeading", payload.get("hs_heading"))
    if not isinstance(country, str) or not isinstance(heading, str):
        return None
    try:
        return validate_country(country), validate_heading(heading)
    except ValueError:
        return None


def handle_discovery_completed(payload: Any, meta: EventMeta) -> None:
    cell = parse_discovery_completed(payload)
    if cell is None:
        raise NonRetryable(f"EV-05 payload does not name a country × heading cell: {payload!r}")
    # A degraded run with no new companies still recomputes: freshness may have decayed.
    enqueue_recompute_cell(meta.tx, cell[0], cell[1])


def handle_recompute_cell(p: RecomputeCellPayload, meta: JobMeta) -> None:
    recompute_cell(_store_factory(), p.country, p.heading)


def handle_recompute_all(p: RecomputeAllPayload, meta: JobMeta) -> None:
    res = recompute_all(_store_factory(), p.countries)
    _log.info("coverage recompute_all done", extra={"reason": p.reason, "written": res.written,
                                                   "deleted": res.deleted, "job_id": meta.job_id})


def register_coverage_jobs() -> None:
    """Idempotent: registers the handlers, the EV-05 subscription and the nightly schedule."""
    global _registered
    with _lock:
        if _registered:
            return
        register_handler(RECOMPUTE_CELL_JOB, RecomputeCellPayload, handle_recompute_cell)
        register_handler(RECOMPUTE_ALL_JOB, RecomputeAllPayload, handle_recompute_all)
        subscribe(EV_DISCOVERY_COMPLETED, EV05_HANDLER, handle_discovery_completed, queue=QUEUE)
        register_schedule(NIGHTLY_SCHEDULE, NIGHTLY_CRON, RECOMPUTE_ALL_JOB, {"reason": "nightly"}, QUEUE)
        _registered = True
