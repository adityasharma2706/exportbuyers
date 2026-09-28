"""M24 job and event wiring (M02 IF-02a/c), on the 'knowledge' queue.

- EV-01 ``entity.changed`` → ``m24.evaluate``, filtered to attribute classes in
  ``{registry, domain, contact, activity_aggregate, sanctions_flag}`` (LLD M24 Triggers; HLD OQ4).
  Debounced 60 s per company, the same way M09's own projection is (a burst of writes about one
  company — e.g. M22 enrichment landing several ``contact.*`` facts — should not run the checks
  once per fact).
- ``m24.evaluate {company_id}`` opens its own connection (job handlers are not handed one — see
  M02) and calls ``engine.evaluate_company``, which does the vendor calls and the M09 writes.
"""
from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from kp.m01_platform import get_logger
from kp.m02_queue import EventMeta, JobMeta, NonRetryable, enqueue, register_handler, subscribe
from kp.m09_evidence import EV_ENTITY_CHANGED, CompanyNotFound, EntityChanged

from .engine import evaluate_company
from .models import RollupResult

_log = get_logger("kp.m24_trust.jobs")

EVALUATE_JOB = "m24.evaluate"
QUEUE = "knowledge"
TRIGGER_CLASSES: frozenset[str] = frozenset({"registry", "domain", "contact", "activity_aggregate", "sanctions_flag"})
DEBOUNCE = timedelta(seconds=60)  # [tunable] mirrors M09's PROJECT_DEBOUNCE

_registered = False
_lock = threading.Lock()


class EvaluatePayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    company_id: UUID


def enqueue_evaluate(tx: Any, company_id: str, *, now: datetime | None = None, debounce: bool = True) -> str:
    t = now or datetime.now(timezone.utc)
    if debounce:
        bucket = int(t.timestamp() // DEBOUNCE.total_seconds())
        key = f"m24:{company_id}:{bucket}"
        run_at: datetime | None = t + DEBOUNCE
    else:
        key = f"m24:{company_id}:now:{int(t.timestamp() * 1000)}"
        run_at = None
    return enqueue(tx, type=EVALUATE_JOB, queue=QUEUE, payload={"company_id": str(company_id)},
                   idempotency_key=key, run_at=run_at)


def on_entity_changed(payload: Any, meta: EventMeta) -> None:
    ev = EntityChanged.model_validate(payload)
    if not (set(ev.attribute_classes) & TRIGGER_CLASSES):
        return
    enqueue_evaluate(meta.tx, str(ev.company_id))


def run_evaluate(company_id: str) -> RollupResult:
    return evaluate_company(company_id)


def handle_evaluate(p: EvaluatePayload, meta: JobMeta) -> None:
    try:
        rollup = run_evaluate(str(p.company_id))
    except CompanyNotFound as e:
        raise NonRetryable(str(e)) from e
    _log.info("trust evaluated", extra={"company_id": str(p.company_id), "level": rollup.level,
                                         "rule_version": rollup.rule_version})


def register_trust_jobs() -> None:
    """Idempotent: registers the handler and the EV-01 subscription."""
    global _registered
    with _lock:
        if _registered:
            return
        register_handler(EVALUATE_JOB, EvaluatePayload, handle_evaluate)
        subscribe(EV_ENTITY_CHANGED, "m24.evaluate", on_entity_changed)
        _registered = True


def reset_registration_for_testing() -> None:
    global _registered
    with _lock:
        _registered = False
