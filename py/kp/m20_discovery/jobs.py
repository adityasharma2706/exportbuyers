"""M20 job wiring (M02 IF-02a / IF-02b / IF-02c), all on the 'knowledge' queue.

- ``m20.discover {hsHeading, country, reason, requestedBy?}`` (IF-20a). Idempotency key
  ``disc:<heading>:<country>:<yyyy-mm-dd>``: requests for the same cell on the same day (pre-warm or
  on-demand) share one job. Rate class ``search_api``.
- ``m20.prewarm`` — weekly schedule; fans out one ``m20.discover`` per country × heading in
  ``/config/prewarm.yaml``, staggered over ``spread_hours``.
- At the end of every run: EV-05 ``discovery.completed {country, hsHeading, newCompanies, runId,
  degraded}`` — the completion event on-demand requesters wait for (and M15 recomputes on).

Search-API outage: the job raises so M02 retries it with backoff (M26 keeps showing "finding
more"); on the 3rd failed attempt it completes with ``EV-05 {newCompanies: 0, degraded: true}``.
"""
from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from kp.m01_platform import get_logger, get_secret, new_id
from kp.m02_queue import (
    JobMeta,
    NonRetryable,
    emit,
    enqueue,
    register_event_schema,
    register_handler,
    register_rate_class,
    register_schedule,
)

from .config import get_prewarm_plan
from .models import (
    DEGRADE_AFTER_ATTEMPTS,
    DISCOVER_JOB,
    DISCOVERY_V,
    EV_DISCOVERY_COMPLETED,
    MAX_ATTEMPTS,
    PREWARM_JOB,
    PREWARM_SCHEDULE,
    QUEUE,
    SEARCH_RATE_CLASS,
    DiscoverPayload,
    DiscoveryRun,
    PrewarmPayload,
    Reason,
    idempotency_key,
)
from .pipeline import DiscoveryDeps, run_discovery
from .search import SearchUnavailable

_log = get_logger("kp.m20_discovery.jobs")

SEARCH_MAX_CONCURRENCY = 4      # [tunable]
SEARCH_PER_SECOND = 1.0         # [tunable]


class DiscoveryCompleted(BaseModel):
    """EV-05 payload."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)
    country: str = Field(pattern=r"^[A-Z]{2}$")
    hs_heading: str = Field(alias="hsHeading", pattern=r"^\d{4}$")
    new_companies: int = Field(alias="newCompanies", ge=0)
    run_id: str = Field(alias="runId", min_length=1)
    degraded: bool = False


# ---- transaction plumbing (replaceable in tests) ---------------------------------------------------

def _default_conn() -> Any:
    import psycopg

    # psycopg's connection context manager commits on a clean exit and rolls back on error.
    return psycopg.connect(get_secret("DATABASE_URL"))


_conn_factory: Callable[[], Any] = _default_conn
_deps: DiscoveryDeps | None = None


def set_conn_factory_for_testing(factory: Callable[[], Any] | None) -> None:
    """``factory()`` returns a context manager yielding an object with ``execute`` (the M02 Tx)."""
    global _conn_factory
    _conn_factory = factory or _default_conn


def set_deps_for_testing(deps: DiscoveryDeps | None) -> None:
    global _deps
    _deps = deps


# ---- producers ------------------------------------------------------------------------------------

def request_discovery(tx: Any, hs_heading: str, country: str, reason: Reason = "on_demand", *,
                      requested_by: str | UUID | None = None, run_at: datetime | None = None,
                      now: datetime | None = None, domain: str | None = None) -> str:
    """Enqueues ``m20.discover`` in ``tx`` and returns the job id. Same cell + same day → same job,
    so concurrent on-demand requests are deduplicated. The requester learns of completion from
    EV-05 ``discovery.completed`` for ``(country, hsHeading)``."""
    p = DiscoverPayload.model_validate({"hsHeading": hs_heading, "country": country, "reason": reason,
                                        "requestedBy": str(requested_by) if requested_by else None,
                                        "domain": domain})
    day = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    key = idempotency_key(p.hs_heading, p.country, day)
    if p.domain:
        key = f"{key}:{p.domain}"
    return enqueue(tx, type=DISCOVER_JOB, queue=QUEUE, payload=p.to_job_payload(), idempotency_key=key,
                   run_at=run_at, rate_class=SEARCH_RATE_CLASS, max_attempts=MAX_ATTEMPTS)


def completion_payload(run: DiscoveryRun, payload: DiscoverPayload) -> dict[str, Any]:
    out: dict[str, Any] = {
        "country": run.country,
        "hsHeading": run.hs_heading,
        "newCompanies": run.new_companies,
        "runId": run.run_id,
        "degraded": run.degraded,
        "reason": payload.reason,
        "discoveryV": DISCOVERY_V,
    }
    if payload.requested_by is not None:
        out["requestedBy"] = str(payload.requested_by)
    return out


def _emit_completed(run: DiscoveryRun, payload: DiscoverPayload) -> str:
    with _conn_factory() as conn:
        return emit(conn, EV_DISCOVERY_COMPLETED, completion_payload(run, payload))


# ---- handlers -------------------------------------------------------------------------------------

def handle_discover(p: DiscoverPayload, meta: JobMeta) -> DiscoveryRun:
    run_id = meta.job_id if meta.job_id else new_id()
    try:
        run = run_discovery(p, _deps, run_id=f"{run_id}:{meta.attempt}")
    except SearchUnavailable as e:
        if meta.attempt < DEGRADE_AFTER_ATTEMPTS:
            _log.warning("search API unavailable; job will retry",
                         extra={"attempt": meta.attempt, "country": p.country, "hs_heading": p.hs_heading})
            raise
        _log.error("search API unavailable after retries; completing degraded",
                   extra={"attempt": meta.attempt, "country": p.country, "hs_heading": p.hs_heading,
                          "err": e.message})
        run = DiscoveryRun(run_id=f"{run_id}:{meta.attempt}", country=p.country, hs_heading=p.hs_heading,
                           reason=p.reason, degraded=True)
    event_id = _emit_completed(run, p)
    _log.info("discovery completed", extra={"event_id": event_id, "run": run.summary()})
    return run


def handle_prewarm(_p: PrewarmPayload, meta: JobMeta | None = None, *, now: datetime | None = None) -> int:
    """Fans the weekly pre-warm out into ``m20.discover`` jobs. Returns the number enqueued."""
    plan = get_prewarm_plan()
    cells = plan.cells()
    if not cells:
        raise NonRetryable("prewarm plan is empty")
    t0 = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    step = timedelta(hours=plan.spread_hours) / len(cells) if plan.spread_hours else timedelta(0)
    # Interleave countries so each country's cells are spread across the whole window.
    ordered = [(c, h) for h in plan.headings for c in plan.countries]
    n = 0
    with _conn_factory() as conn:
        for i, (country, heading) in enumerate(ordered):
            request_discovery(conn, heading, country, "prewarm", run_at=t0 + step * i, now=t0)
            n += 1
    _log.info("prewarm fanned out", extra={"jobs": n, "spread_hours": plan.spread_hours})
    return n


# ---- registration ---------------------------------------------------------------------------------

_registered = False
_lock = threading.Lock()


def register_discovery_jobs() -> None:
    """Idempotent: registers the handlers, the search rate class, EV-05's schema and the weekly
    pre-warm schedule."""
    global _registered
    with _lock:
        if _registered:
            return
        register_rate_class(SEARCH_RATE_CLASS, SEARCH_MAX_CONCURRENCY, SEARCH_PER_SECOND)
        register_event_schema(EV_DISCOVERY_COMPLETED, DiscoveryCompleted)
        register_handler(DISCOVER_JOB, DiscoverPayload, lambda p, m: handle_discover(p, m))
        register_handler(PREWARM_JOB, PrewarmPayload, lambda p, m: handle_prewarm(p, m))
        register_schedule(PREWARM_SCHEDULE, get_prewarm_plan().cron, PREWARM_JOB, {}, QUEUE)
        _registered = True


def reset_registration_for_testing() -> None:
    global _registered
    with _lock:
        _registered = False
