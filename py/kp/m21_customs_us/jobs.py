"""M21 job wiring (M02), on the 'knowledge' queue.

- ``m21.ingest_week {week?, vendor?, skipFetch?}`` — idempotency key ``m21:<source_id>:<YYYY-WW>``
  so one week is ingested once per request burst; rate class ``customs_us`` (one run at a time).
- Weekly schedule ``m21.ingest-weekly`` (``cron`` in ``config/customs_us.yaml``), registered only
  once a vendor is configured (architecture OQ1 is still open).

Errors: a delivery that has not arrived yet (``DeliveryMissing``) and vendor/storage outages retry
with M02 backoff; a missing vendor configuration or an unregistered source is non-retryable.
"""
from __future__ import annotations

import threading
from datetime import datetime
from typing import Any

from kp.m01_platform import KpError, get_logger
from kp.m02_queue import JobMeta, NonRetryable, enqueue, register_handler, register_rate_class, register_schedule
from kp.m08_sources import SourceNotActive, SourceNotRegistered

from .config import get_customs_config
from .models import (
    INGEST_JOB,
    INGEST_SCHEDULE,
    MAX_ATTEMPTS,
    QUEUE,
    RATE_CLASS,
    IngestRun,
    IngestWeekPayload,
    IsoWeek,
    source_id_for,
)
from .pipeline import CustomsDeps, VendorNotConfigured, ingest_week

_log = get_logger("kp.m21_customs_us.jobs")

_deps: CustomsDeps | None = None


def set_deps_for_testing(deps: CustomsDeps | None) -> None:
    global _deps
    _deps = deps


def ingest_idempotency_key(source_id: str, week: IsoWeek, skip_fetch: bool = False) -> str:
    return f"m21:{source_id}:{week}" + (":agg" if skip_fetch else "")


def request_ingest(tx: Any, week: str | IsoWeek, *, vendor: str | None = None, skip_fetch: bool = False,
                   run_at: datetime | None = None) -> str:
    """Enqueues ``m21.ingest_week`` for one week in ``tx`` (operator back-fills, re-aggregation)."""
    w = week if isinstance(week, IsoWeek) else IsoWeek.parse(week)
    v = vendor or get_customs_config().vendor
    if not v:
        raise VendorNotConfigured("no vendor given and none configured")
    p = IngestWeekPayload.model_validate({"week": str(w), "vendor": v, "skipFetch": skip_fetch})
    return enqueue(tx, type=INGEST_JOB, queue=QUEUE, payload=p.model_dump(by_alias=True, exclude_none=True),
                   idempotency_key=ingest_idempotency_key(source_id_for(v), w, skip_fetch), run_at=run_at,
                   rate_class=RATE_CLASS, max_attempts=MAX_ATTEMPTS)


def handle_ingest(p: IngestWeekPayload, meta: JobMeta | None = None, *, now: datetime | None = None) -> IngestRun:
    week = IsoWeek.parse(p.week) if p.week else IsoWeek.last_complete(now)
    run_id = f"{meta.job_id}:{meta.attempt}" if meta and meta.job_id else None
    try:
        return ingest_week(week, _deps, vendor_name=p.vendor, skip_fetch=p.skip_fetch, run_id=run_id, now=now)
    except (VendorNotConfigured, SourceNotRegistered, SourceNotActive) as e:
        _log.error("customs ingest cannot run", extra={"week": str(week), "err": e.message})
        raise NonRetryable(e.message) from e
    except KpError as e:
        if e.code == "VALIDATION":
            raise NonRetryable(e.message) from e
        raise


_registered = False
_lock = threading.Lock()


def register_customs_jobs() -> None:
    """Idempotent: registers the handler and rate class, and the weekly schedule when a vendor is set."""
    global _registered
    with _lock:
        if _registered:
            return
        register_rate_class(RATE_CLASS, 1, 1.0)
        register_handler(INGEST_JOB, IngestWeekPayload, lambda p, m: handle_ingest(p, m))
        cfg = get_customs_config()
        if cfg.vendor:
            register_schedule(INGEST_SCHEDULE, cfg.cron, INGEST_JOB, {"vendor": cfg.vendor}, QUEUE)
        else:
            _log.info("US customs vendor not configured; weekly schedule not registered")
        _registered = True


def reset_registration_for_testing() -> None:
    global _registered
    with _lock:
        _registered = False
