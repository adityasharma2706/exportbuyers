"""M25 job wiring (M02 IF-02a / IF-02b), on the 'knowledge' queue.

- ``m25.reverify {assertionIds, trigger, triggerRef}`` — the **nightly-only** durable path. Reveal
  (M29) and after-report (M30) calls go through ``pipeline.reverify`` (IF-25a) directly, or the
  ``/rpc/reverify`` HTTP endpoint (``rpc.py``): those are latency-sensitive, small batches that run
  on the shared pool in-process, so there is no queued job for them (queuing and then also running
  inline would mean paying the email vendor twice for the same address). The nightly scheduler, by
  contrast, handles up to ``NIGHTLY_CONTACT_LIMIT`` contacts a night, so it is chunked into queued,
  rate-limited, retryable jobs the normal M02 way.
- ``m25.nightly`` — daily schedule (LLD M25 "Nightly schedule"):
  ``stale('contact.', 90d, limit=5000)`` → chunks of ``m25.reverify`` jobs (trigger ``'schedule'``).
  ``stale('product_evidence', 180d)`` → one ``m20.discover`` re-crawl per distinct
  (heading, country, domain) cell, reusing M20's own on-demand dedup.
"""
from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Iterator, TypeVar

from kp.m01_platform import get_logger, get_secret
from kp.m02_queue import (
    JobMeta,
    enqueue,
    register_event_schema,
    register_handler,
    register_rate_class,
    register_schedule,
)
from kp.m09_evidence import get_company, stale
from kp.m20_discovery import request_discovery

from .models import (
    CONTACT_STALE_DAYS,
    EV_CONTACT_INVALIDATED,
    EV_CONTACT_VERIFIED,
    MAX_ATTEMPTS,
    NIGHTLY_CHUNK_SIZE,
    NIGHTLY_CONTACT_LIMIT,
    NIGHTLY_CRON,
    NIGHTLY_JOB,
    NIGHTLY_RECRAWL_LIMIT,
    NIGHTLY_SCHEDULE,
    QUEUE,
    RATE_CLASS,
    RECRAWL_DAYS,
    REVERIFY_JOB,
    ContactInvalidatedEvent,
    ContactVerifiedEvent,
    NightlyPayload,
    ReverifyPayload,
    idempotency_key,
)
from .pipeline import ReverifyDeps, reverify_assertions

_log = get_logger("kp.m25_freshness.jobs")

RATE_MAX_CONCURRENCY = 6   # [tunable] the email vendor and outbound HTTP checks are rate-limited
RATE_PER_SECOND = 3.0      # [tunable]

T = TypeVar("T")


def _chunks(items: list[T], size: int) -> Iterator[list[T]]:
    for i in range(0, len(items), size):
        yield items[i:i + size]


# ---- transaction plumbing (replaceable in tests) ---------------------------------------------

def _default_conn() -> Any:
    import psycopg

    return psycopg.connect(get_secret("DATABASE_URL"))


_conn_factory: Callable[[], Any] = _default_conn
_deps: ReverifyDeps | None = None


def set_conn_factory_for_testing(factory: Callable[[], Any] | None) -> None:
    global _conn_factory
    _conn_factory = factory or _default_conn


def set_deps_for_testing(deps: ReverifyDeps | None) -> None:
    global _deps
    _deps = deps


# ---- producers ----------------------------------------------------------------------------------

def request_reverify(tx: Any, assertion_ids: Iterable[Any], trigger: str, trigger_ref: str, *,
                     chunk_size: int = NIGHTLY_CHUNK_SIZE) -> list[str]:
    """Enqueues one ``m25.reverify`` job per ``chunk_size`` assertions (nightly path only)."""
    size = min(chunk_size, NIGHTLY_CHUNK_SIZE)   # ReverifyPayload accepts at most NIGHTLY_CHUNK_SIZE ids
    ids = [str(i) for i in dict.fromkeys(assertion_ids)]
    job_ids: list[str] = []
    for i, chunk in enumerate(_chunks(ids, size)):
        p = ReverifyPayload.model_validate({"assertionIds": chunk, "trigger": trigger, "triggerRef": trigger_ref})
        job_ids.append(enqueue(tx, type=REVERIFY_JOB, queue=QUEUE, payload=p.to_job_payload(),
                               idempotency_key=idempotency_key(trigger, trigger_ref, i),
                               rate_class=RATE_CLASS, max_attempts=MAX_ATTEMPTS))
    return job_ids


# ---- handlers -------------------------------------------------------------------------------------

def handle_reverify(p: ReverifyPayload, meta: JobMeta) -> dict[str, Any]:
    outcomes = reverify_assertions([str(a) for a in p.assertion_ids], p.trigger, p.trigger_ref, _deps, wait_s=None)
    counts: dict[str, int] = {}
    for o in outcomes:
        counts[o.status] = counts.get(o.status, 0) + 1
    _log.info("m25.reverify finished", extra={"attempt": meta.attempt, "trigger": p.trigger,
                                              "trigger_ref": p.trigger_ref, "counts": counts})
    return {"assertionIds": [o.assertion_id for o in outcomes], "counts": counts}


def handle_nightly(_p: NightlyPayload, meta: JobMeta | None = None, *, now: datetime | None = None) -> dict[str, Any]:
    """Fans the nightly freshness sweep out (LLD M25 "Nightly schedule")."""
    t0 = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    day = t0.strftime("%Y-%m-%d")
    contacts_enqueued = 0
    recrawls_requested = 0
    with _conn_factory() as conn:
        stale_contacts = stale("contact.", timedelta(days=CONTACT_STALE_DAYS), NIGHTLY_CONTACT_LIMIT, tx=conn)
        contact_ids = [a.id for a in stale_contacts]
        if contact_ids:
            # One request_reverify call over the whole batch: its own internal chunking numbers
            # every job 0, 1, 2, ... against this single trigger_ref, so idempotency keys never
            # collide across chunks (they would if this were called once per outer chunk).
            request_reverify(conn, contact_ids, "schedule", f"nightly:{day}", chunk_size=NIGHTLY_CHUNK_SIZE)
            contacts_enqueued = len(contact_ids)

        stale_evidence = stale("product_evidence", timedelta(days=RECRAWL_DAYS), NIGHTLY_RECRAWL_LIMIT, tx=conn)
        seen_cells: set[tuple[str, str, str | None]] = set()
        for a in stale_evidence:
            heading = a.value.get("hs_heading")
            if not isinstance(heading, str):
                continue
            company = get_company(a.subject_id, tx=conn)
            if company is None or company.status == "closed":
                continue
            cell = (heading, company.country, company.primary_domain)
            if cell in seen_cells:
                continue
            seen_cells.add(cell)
            request_discovery(conn, heading, company.country, "on_demand", domain=company.primary_domain, now=t0)
            recrawls_requested += 1
    result = {"contactsEnqueued": contacts_enqueued, "recrawlsRequested": recrawls_requested, "day": day}
    _log.info("m25.nightly finished", extra={"attempt": getattr(meta, "attempt", None), **result})
    return result


# ---- registration ---------------------------------------------------------------------------------

_registered = False
_lock = threading.Lock()


def register_freshness_jobs() -> None:
    """Idempotent: registers the reverify handler, its rate class, the nightly job/schedule and
    EV-06's event schemas."""
    global _registered
    with _lock:
        if _registered:
            return
        register_rate_class(RATE_CLASS, RATE_MAX_CONCURRENCY, RATE_PER_SECOND)
        register_handler(REVERIFY_JOB, ReverifyPayload, lambda p, m: handle_reverify(p, m))
        register_handler(NIGHTLY_JOB, NightlyPayload, lambda p, m: handle_nightly(p, m))
        register_schedule(NIGHTLY_SCHEDULE, NIGHTLY_CRON, NIGHTLY_JOB, {}, QUEUE)
        register_event_schema(EV_CONTACT_VERIFIED, ContactVerifiedEvent)
        register_event_schema(EV_CONTACT_INVALIDATED, ContactInvalidatedEvent)
        _registered = True


def reset_registration_for_testing() -> None:
    global _registered
    with _lock:
        _registered = False


__all__ = [
    "handle_nightly",
    "handle_reverify",
    "register_freshness_jobs",
    "request_reverify",
    "reset_registration_for_testing",
    "set_conn_factory_for_testing",
    "set_deps_for_testing",
]
