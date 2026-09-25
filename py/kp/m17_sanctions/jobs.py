"""M17 job and event wiring (M02 IF-02a/b/c), all on the 'knowledge' queue.

- ``m17.ingest {lists?}``                 daily at 03:00 IST (21:30 UTC; M02 crons are UTC). Diffs each
                                          list; on any change emits EV-02 ``sanctions.list_changed``.
- EV-02 → handler ``m17.rescreen``        enqueues the first ``m17.rescreen_batch``.
- ``m17.rescreen_batch {run_key, after?}`` re-screens up to 10k companies in id order, then chains the
                                          next batch.
- EV-01 ``entity.changed`` → ``m17.screen_on_change``  screening at ingestion: new or renamed
                                          companies are screened; unchanged ones hit the stored screen.
- ``m17.record_decision {company_id, decision, review_item_id?}``  enqueued by the serving-plane
                                          outcome handler of ``sanctions.possible_match``.
"""
from __future__ import annotations

import threading
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from kp.m01_platform import KpError, get_logger, get_secret
from kp.m02_queue import (
    EventMeta,
    JobMeta,
    NonRetryable,
    emit,
    enqueue,
    register_event_schema,
    register_handler,
    register_rate_class,
    register_schedule,
    subscribe,
)
from kp.m09_evidence import EV_ENTITY_CHANGED, CompanyNotFound, EntityChanged

from .ingest import EV_LISTS_CHANGED, RATE_CLASS, IngestReport, apply_batches, collect
from .models import LIST_KEYS
from .screener import record_decision, screen_company
from .store import PgSanctionsStore, SanctionsStore

INGEST_JOB = "m17.ingest"
RESCREEN_JOB = "m17.rescreen_batch"
RECORD_DECISION_JOB = "m17.record_decision"
QUEUE = "knowledge"
DAILY_CRON = "30 21 * * *"      # 03:00 IST
RESCREEN_BATCH = 10_000

_log = get_logger("kp.m17_sanctions.jobs")
_registered = False
_lock = threading.Lock()
_tx_factory: Callable[[], Any] | None = None
_store_factory: Callable[[Any], SanctionsStore] = PgSanctionsStore


def set_tx_factory_for_testing(factory: Callable[[], Any] | None) -> None:
    global _tx_factory
    _tx_factory = factory


def set_store_factory_for_testing(factory: Callable[[Any], SanctionsStore] | None) -> None:
    global _store_factory
    _store_factory = factory or PgSanctionsStore


def _tx() -> Any:
    if _tx_factory is not None:
        return _tx_factory()
    import psycopg

    return psycopg.connect(get_secret("DATABASE_URL"))


class IngestPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lists: list[str] | None = Field(default=None, max_length=5)

    @field_validator("lists")
    @classmethod
    def _l(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        for k in v:
            if k not in LIST_KEYS:
                raise ValueError(f"unknown list {k}")
        return list(dict.fromkeys(v))


class ListsChanged(BaseModel):
    """EV-02 payload."""
    model_config = ConfigDict(extra="ignore")
    lists: list[str]
    list_versions: dict[str, str] = Field(default_factory=dict)
    changed_entry_count: int = 0


class RescreenPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_key: str = Field(min_length=1, max_length=200)
    after: str | None = Field(default=None, pattern=r"^[0-9a-f-]{36}$")


class RecordDecisionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    company_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    decision: Literal["confirmed", "cleared"]
    review_item_id: str | None = None


def run_ingest(lists: list[str] | None = None, *, correlation_id: str | None = None) -> IngestReport:
    report = IngestReport()
    batches = collect(lists or list(LIST_KEYS), correlation_id=correlation_id, report=report)
    apply_batches(batches, _tx, store_factory=_store_factory,
                  emit_changed=lambda tx, payload: emit(tx, EV_LISTS_CHANGED, payload), report=report)
    _log.info("sanctions ingest finished", extra=report.as_dict())
    return report


def handle_ingest(p: IngestPayload, meta: JobMeta) -> None:
    report = run_ingest(p.lists, correlation_id=meta.correlation_id)
    problems = {**report.failed_sources, **report.rejected}
    if problems:
        # Lists that did apply are committed; a retry re-diffs them as no-ops and retries the rest.
        raise KpError("UPSTREAM_UNAVAILABLE", "some sanctions lists were not applied", {"lists": problems})


def enqueue_rescreen(tx: Any, run_key: str, after: str | None = None) -> str:
    payload: dict[str, Any] = {"run_key": run_key}
    if after is not None:
        payload["after"] = after
    return enqueue(tx, type=RESCREEN_JOB, queue=QUEUE, payload=payload,
                   idempotency_key=f"{run_key}:{after or 'start'}")


def run_rescreen_batch(run_key: str, after: str | None) -> tuple[int, int, str | None]:
    """Screens one batch; returns (screened, failed, next_after or None when finished)."""
    with _tx() as tx:
        ids = _store_factory(tx).company_ids_after(after, RESCREEN_BATCH)
    screened = failed = 0
    for cid in ids:
        try:
            with _tx() as tx:
                screen_company(cid, tx=tx, store=_store_factory(tx), force=True)
            screened += 1
        except CompanyNotFound:
            continue
        except Exception:  # noqa: BLE001 — one company must not stop the batch; counted and logged
            failed += 1
            _log.exception("re-screen failed", extra={"company_id": cid, "run_key": run_key})
    nxt = ids[-1] if len(ids) == RESCREEN_BATCH else None
    if nxt is not None:
        with _tx() as tx:
            enqueue_rescreen(tx, run_key, nxt)
    return screened, failed, nxt


def handle_rescreen(p: RescreenPayload, meta: JobMeta) -> None:
    screened, failed, nxt = run_rescreen_batch(p.run_key, p.after)
    _log.info("re-screen batch", extra={"run_key": p.run_key, "after": p.after, "screened": screened,
                                        "failed": failed, "next": nxt})
    if failed and screened == 0:
        raise KpError("UPSTREAM_UNAVAILABLE", "every company in the re-screen batch failed", {"failed": failed})


def on_lists_changed(payload: Any, meta: EventMeta) -> None:
    ev = ListsChanged.model_validate(payload)
    enqueue_rescreen(meta.tx, f"lists:{meta.event_id}")
    _log.info("sanctions lists changed; re-screen started", extra={"lists": ev.lists, "event_id": meta.event_id})


def on_entity_changed(payload: Any, meta: EventMeta) -> None:
    ev = EntityChanged.model_validate(payload)
    try:
        screen_company(str(ev.company_id), tx=meta.tx, store=_store_factory(meta.tx))
    except CompanyNotFound:
        return


def handle_record_decision(p: RecordDecisionPayload, meta: JobMeta) -> None:
    try:
        with _tx() as tx:
            found = record_decision(p.company_id, p.decision, tx=tx, store=_store_factory(tx))
    except CompanyNotFound as e:
        raise NonRetryable(str(e)) from e
    if not found:
        _log.warning("decision for a company without a stored screen", extra={"company_id": p.company_id})


def register_sanctions_jobs() -> None:
    """Idempotent: registers handlers, subscriptions, the rate class and the daily schedule."""
    global _registered
    with _lock:
        if _registered:
            return
        register_rate_class(RATE_CLASS, 1, 1.0)
        register_event_schema(EV_LISTS_CHANGED, ListsChanged)
        register_handler(INGEST_JOB, IngestPayload, handle_ingest)
        register_handler(RESCREEN_JOB, RescreenPayload, handle_rescreen)
        register_handler(RECORD_DECISION_JOB, RecordDecisionPayload, handle_record_decision)
        subscribe(EV_LISTS_CHANGED, "m17.rescreen", on_lists_changed)
        subscribe(EV_ENTITY_CHANGED, "m17.screen_on_change", on_entity_changed)
        register_schedule("m17.sanctions-daily", DAILY_CRON, INGEST_JOB, {}, QUEUE)
        _registered = True


def reset_registration_for_testing() -> None:
    global _registered
    _registered = False
