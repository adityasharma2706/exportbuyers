"""M22 job wiring (M02 IF-02a / IF-02c), on the 'knowledge' queue.

- ``m22.enrich {companyId, reason?}`` — idempotency key ``enrich:<companyId>:<yyyy-mm-dd>``, so a
  company is enriched at most once per day however many triggers arrive (this also stops the loop
  where M22's own contact/domain writes emit EV-01 again).
- EV-01 ``entity.changed`` → handler ``m22.enrich_on_change``: enqueues ``m22.enrich`` when the
  attribute classes include ``product_evidence`` or ``domain``.
- M25 (freshness) asks through ``request_enrichment(tx, company_id, reason='reverify')``.
"""
from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from kp.m01_platform import KpError, get_logger
from kp.m02_queue import EventMeta, JobMeta, NonRetryable, enqueue, register_handler, register_rate_class, subscribe
from kp.m09_evidence import EV_ENTITY_CHANGED, EntityChanged

from .models import (
    ENRICH_JOB,
    ENRICH_RATE_CLASS,
    EV01_HANDLER,
    MAX_ATTEMPTS,
    QUEUE,
    TRIGGER_CLASSES,
    EnrichPayload,
    EnrichResult,
    Reason,
    idempotency_key,
)
from .pipeline import EnrichDeps, enrich_company

_log = get_logger("kp.m22_enrichment.jobs")

ENRICH_MAX_CONCURRENCY = 8      # [tunable] per-domain pacing is done by the crawler itself
ENRICH_PER_SECOND = 4.0         # [tunable]

_deps: EnrichDeps | None = None


def set_deps_for_testing(deps: EnrichDeps | None) -> None:
    global _deps
    _deps = deps


def request_enrichment(tx: Any, company_id: str | UUID, reason: Reason = "entity_changed", *,
                       now: datetime | None = None) -> str:
    """Enqueues ``m22.enrich`` in ``tx``; the same company on the same day shares one job."""
    p = EnrichPayload.model_validate({"companyId": str(company_id), "reason": reason})
    day = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return enqueue(tx, type=ENRICH_JOB, queue=QUEUE, payload=p.to_job_payload(),
                   idempotency_key=idempotency_key(str(p.company_id), day),
                   rate_class=ENRICH_RATE_CLASS, max_attempts=MAX_ATTEMPTS)


def should_enrich(attribute_classes: list[str]) -> bool:
    return bool(TRIGGER_CLASSES.intersection(attribute_classes))


def on_entity_changed(payload: Any, meta: EventMeta) -> None:
    ev = EntityChanged.model_validate(payload)
    if not should_enrich(ev.attribute_classes):
        return
    request_enrichment(meta.tx, str(ev.company_id), "entity_changed")


def handle_enrich(p: EnrichPayload, meta: JobMeta) -> EnrichResult:
    try:
        result = enrich_company(str(p.company_id), _deps)
    except KpError as e:
        if e.code in ("VALIDATION", "POLICY_DENIED", "NOT_FOUND"):
            raise NonRetryable(f"{e.code}: {e.message}") from e
        raise
    _log.info("m22.enrich done", extra={"attempt": meta.attempt, "reason": p.reason, "result": result.summary()})
    return result


_registered = False
_lock = threading.Lock()


def register_enrichment_jobs() -> None:
    """Idempotent: the handler, its rate class and the EV-01 subscription."""
    global _registered
    with _lock:
        if _registered:
            return
        register_rate_class(ENRICH_RATE_CLASS, ENRICH_MAX_CONCURRENCY, ENRICH_PER_SECOND)
        register_handler(ENRICH_JOB, EnrichPayload, lambda p, m: handle_enrich(p, m))
        subscribe(EV_ENTITY_CHANGED, EV01_HANDLER, on_entity_changed, queue=QUEUE)
        _registered = True


def reset_registration_for_testing() -> None:
    global _registered
    with _lock:
        _registered = False
