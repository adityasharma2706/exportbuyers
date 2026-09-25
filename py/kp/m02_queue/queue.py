"""M02 — producer API and registries for the knowledge plane. Mirror of queue.ts / registry.ts.

    enqueue(tx, type=..., queue=..., payload=..., idempotency_key=..., ...)   IF-02a
    register_handler(type, schema, fn)                                          IF-02a
    register_schedule(name, cron, job_type, payload, queue)                     IF-02b
    emit(tx, type, payload) / subscribe(type, handler_name, fn)                 IF-02c

``tx`` is a psycopg 3 connection (or cursor-bearing object with ``execute``) whose current
transaction the job/event joins; the caller commits.
"""
from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Literal, Mapping, Protocol

from kp.m01_platform import KpError, current_correlation_id, get_logger, new_id

from .cron import parse_cron

QueueName = Literal["serving", "knowledge"]
QUEUE_NAMES: tuple[str, ...] = ("serving", "knowledge")
DEFAULT_MAX_ATTEMPTS = 8
_MAX_KEY = 400

JOB_TYPE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,99}$")
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

_log = get_logger("kp.m02_queue")


class NonRetryable(Exception):
    """Raise from a handler to send the job straight to ``dead`` without retrying."""


class Tx(Protocol):
    def execute(self, query: Any, params: Any = ...) -> Any: ...


@dataclass(frozen=True)
class JobMeta:
    job_id: str
    type: str
    queue: str
    attempt: int
    max_attempts: int
    correlation_id: str
    actor_ref: str | None
    idempotency_key: str
    v: int
    enqueued_at: datetime | None


@dataclass(frozen=True)
class DeadLetterInfo:
    job_id: str
    type: str
    queue: str
    payload: Any
    attempts: int
    max_attempts: int
    last_error: str
    correlation_id: str
    actor_ref: str | None
    reason: Literal["max_attempts", "non_retryable", "invalid_payload", "lease_expired"]


@dataclass(frozen=True)
class EventMeta:
    event_id: str
    event_type: str
    correlation_id: str
    tx: Any
    job: JobMeta


# A schema is either a pydantic v2 model class (has model_validate) or a callable that returns
# the validated payload and raises on invalid input.
Schema = Any
JobHandler = Callable[[Any, JobMeta], None]
EventHandler = Callable[[Any, EventMeta], None]


@dataclass
class _Handler:
    type: str
    schema: Schema
    fn: Callable[..., None]
    # Event handlers need the connection to open their own transaction.
    event: tuple[str, str] | None = None


@dataclass
class _Registries:
    handlers: dict[str, _Handler] = field(default_factory=dict)
    schedules: dict[str, dict[str, Any]] = field(default_factory=dict)
    subscriptions: dict[tuple[str, str], str] = field(default_factory=dict)
    rate_classes: dict[str, tuple[int, float]] = field(default_factory=dict)
    event_schemas: dict[str, Schema] = field(default_factory=dict)
    dead_letter_hooks: list[Callable[[DeadLetterInfo], None]] = field(default_factory=list)
    stale_hooks: list[Callable[[dict[str, Any]], None]] = field(default_factory=list)


_reg = _Registries()
_lock = threading.Lock()


def validate_payload(schema: Schema, payload: Any) -> Any:
    """Returns the validated payload; raises ValueError (or pydantic's ValidationError)."""
    if schema is None:
        return payload
    if hasattr(schema, "model_validate"):
        return schema.model_validate(payload)
    if callable(schema):
        return schema(payload)
    raise KpError("VALIDATION", "schema must be a pydantic model or a validator callable")


def _assert_queue(q: str) -> None:
    if q not in QUEUE_NAMES:
        raise KpError("VALIDATION", f'Unknown queue "{q}"; expected one of {", ".join(QUEUE_NAMES)}')


def _assert_type(t: str) -> None:
    if not isinstance(t, str) or not JOB_TYPE_RE.match(t):
        raise KpError("VALIDATION", f'Invalid job type "{t}"')


def _dump(payload: Any, what: str) -> str:
    if hasattr(payload, "model_dump"):
        payload = payload.model_dump(mode="json")
    try:
        return json.dumps({} if payload is None else payload, separators=(",", ":"), default=str)
    except (TypeError, ValueError) as e:
        raise KpError("VALIDATION", f"{what}: payload is not JSON-serialisable") from e


def _version(payload: Any, explicit: int | None) -> int:
    if explicit is not None:
        if not isinstance(explicit, int) or explicit < 1:
            raise KpError("VALIDATION", "Payload version v must be an integer >= 1")
        return explicit
    v = payload.get("v") if isinstance(payload, Mapping) else getattr(payload, "v", None)
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 1 else 1


def actor_ref_of(ctx: Mapping[str, Any] | None) -> str | None:
    if not ctx:
        return None
    kind = ctx.get("kind", "system")
    if kind == "anonymous":
        return f"anonymous:{ctx.get('anon_session_id') or ''}"
    return f"{kind}:{ctx.get('account_id') or ''}:{ctx.get('member_id') or ''}"


# ---- IF-02a ---------------------------------------------------------------------------

_INSERT_JOB = """
insert into platform.job
  (id, queue, type, payload, v, idempotency_key, correlation_id, actor_ref, rate_class, max_attempts, run_at)
values (%s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s, coalesce(%s::timestamptz, now()))
on conflict (type, idempotency_key) do nothing
returning id
"""


def enqueue(
    tx: Tx,
    *,
    type: str,
    queue: QueueName,
    payload: Any,
    idempotency_key: str,
    run_at: datetime | None = None,
    rate_class: str | None = None,
    max_attempts: int | None = None,
    v: int | None = None,
    ctx: Mapping[str, Any] | None = None,
) -> str:
    """INSERT … ON CONFLICT (type, idempotency_key) DO NOTHING; returns the new or existing id."""
    _assert_type(type)
    _assert_queue(queue)
    if not isinstance(idempotency_key, str) or not (1 <= len(idempotency_key) <= _MAX_KEY):
        raise KpError("VALIDATION", f"enqueue({type}): idempotency_key must be 1..{_MAX_KEY} chars")
    attempts = DEFAULT_MAX_ATTEMPTS if max_attempts is None else max_attempts
    if not isinstance(attempts, int) or not (1 <= attempts <= 100):
        raise KpError("VALIDATION", f"enqueue({type}): max_attempts must be an integer in 1..100")
    if rate_class is not None and not NAME_RE.match(rate_class):
        raise KpError("VALIDATION", f'enqueue({type}): invalid rate_class "{rate_class}"')
    corr = (ctx or {}).get("correlation_id") or current_correlation_id() or new_id()
    params = (
        new_id(), queue, type, _dump(payload, f"enqueue({type})"), _version(payload, v), idempotency_key,
        corr, actor_ref_of(ctx), rate_class, attempts, run_at,
    )
    row = tx.execute(_INSERT_JOB, params).fetchone()
    if row:
        return str(row[0])
    row = tx.execute(
        "select id from platform.job where type = %s and idempotency_key = %s", (type, idempotency_key)
    ).fetchone()
    if row:
        return str(row[0])
    # The conflicting row belonged to a transaction that rolled back: insert again.
    row = tx.execute(
        _INSERT_JOB.replace("do nothing", "do update set updated_at = platform.job.updated_at"), params
    ).fetchone()
    return str(row[0])


def register_handler(type: str, schema: Schema, fn: JobHandler) -> None:
    _assert_type(type)
    if not callable(fn):
        raise KpError("VALIDATION", f"register_handler({type}): fn must be callable")
    with _lock:
        if type in _reg.handlers:
            raise KpError("CONFLICT", f'A handler for job type "{type}" is already registered')
        _reg.handlers[type] = _Handler(type=type, schema=schema, fn=fn)


def get_handler(type: str) -> _Handler | None:
    return _reg.handlers.get(type)


def registered_job_types() -> list[str]:
    return list(_reg.handlers)


# ---- IF-02b ---------------------------------------------------------------------------

def register_schedule(name: str, cron: str, job_type: str, payload: Mapping[str, Any], queue: QueueName) -> None:
    if not NAME_RE.match(name):
        raise KpError("VALIDATION", f'Invalid schedule name "{name}"')
    parse_cron(cron)
    _assert_type(job_type)
    _assert_queue(queue)
    if not isinstance(payload, Mapping):
        raise KpError("VALIDATION", f"register_schedule({name}): payload must be a mapping")
    entry = {"name": name, "cron": cron, "job_type": job_type, "payload": dict(payload), "queue": queue}
    with _lock:
        existing = _reg.schedules.get(name)
        if existing and (existing["cron"], existing["job_type"], existing["queue"]) != (cron, job_type, queue):
            raise KpError("CONFLICT", f'Schedule "{name}" is already registered with a different definition')
        _reg.schedules[name] = entry


def register_rate_class(name: str, max_concurrency: int, per_second: float) -> None:
    if not NAME_RE.match(name):
        raise KpError("VALIDATION", f'Invalid rate class name "{name}"')
    if not isinstance(max_concurrency, int) or max_concurrency < 1:
        raise KpError("VALIDATION", f"Rate class {name}: max_concurrency must be an integer >= 1")
    if not per_second > 0:
        raise KpError("VALIDATION", f"Rate class {name}: per_second must be > 0")
    _reg.rate_classes[name] = (max_concurrency, float(per_second))


# ---- IF-02c ---------------------------------------------------------------------------

def event_job_type(event_type: str, handler: str) -> str:
    return f"evt:{event_type}:{handler}"


def register_event_schema(event_type: str, schema: Schema) -> None:
    _assert_type(event_type)
    _reg.event_schemas[event_type] = schema


def emit(tx: Tx, type: str, payload: Any) -> str:
    """Inserts into platform.outbox inside the caller's transaction; returns the event id."""
    _assert_type(type)
    schema = _reg.event_schemas.get(type)
    if schema is not None:
        try:
            validate_payload(schema, payload)
        except Exception as e:  # noqa: BLE001 — any validator error means invalid input
            raise KpError("VALIDATION", f"emit({type}): payload failed schema validation", {"issues": str(e)}) from e
    event_id = new_id()
    tx.execute(
        "insert into platform.outbox (id, event_type, payload, v, correlation_id) values (%s, %s, %s::jsonb, %s, %s)",
        (event_id, type, _dump(payload, f"emit({type})"), _version(payload, None), current_correlation_id() or new_id()),
    )
    return event_id


def _event_envelope(p: Any) -> dict[str, Any]:
    if not isinstance(p, Mapping):
        raise ValueError("event job payload must be an object")
    if not isinstance(p.get("eventId"), str) or not _UUID_RE.match(p["eventId"]):
        raise ValueError("eventId must be a uuid")
    if not isinstance(p.get("eventType"), str) or not p["eventType"]:
        raise ValueError("eventType is required")
    return {"eventId": p["eventId"], "eventType": p["eventType"], "v": p.get("v", 1), "payload": p.get("payload")}


def subscribe(type: str, handler_name: str, fn: EventHandler, *, queue: QueueName = "knowledge") -> None:
    """Registers ``fn`` for events of ``type``; the handler job is ``evt:<type>:<handler_name>``.

    The worker runs it in a transaction that first records (event_id, handler) in
    platform.event_handled and skips already-handled events.
    """
    _assert_type(type)
    if not NAME_RE.match(handler_name):
        raise KpError("VALIDATION", f'Invalid handler name "{handler_name}"')
    _assert_queue(queue)
    job_type = event_job_type(type, handler_name)
    with _lock:
        if (type, handler_name) in _reg.subscriptions:
            raise KpError("CONFLICT", f'Handler "{handler_name}" is already subscribed to "{type}"')
        if job_type in _reg.handlers:
            raise KpError("CONFLICT", f'A handler for job type "{job_type}" is already registered')
        _reg.subscriptions[(type, handler_name)] = queue
        _reg.handlers[job_type] = _Handler(type=job_type, schema=_event_envelope, fn=fn, event=(type, handler_name))


# ---- hooks ----------------------------------------------------------------------------

def on_dead_letter(fn: Callable[[DeadLetterInfo], None]) -> Callable[[], None]:
    _reg.dead_letter_hooks.append(fn)
    return lambda: _reg.dead_letter_hooks.remove(fn) if fn in _reg.dead_letter_hooks else None


def fire_dead_letter(info: DeadLetterInfo) -> None:
    _log.error("job dead-lettered", extra={"job_id": info.job_id, "job_type": info.type, "reason": info.reason,
                                            "attempts": info.attempts, "last_error": info.last_error})
    for h in list(_reg.dead_letter_hooks):
        try:
            h(info)
        except Exception:  # noqa: BLE001 — a failing hook must not break the worker
            _log.exception("dead-letter hook failed", extra={"job_id": info.job_id})


def on_stale_jobs(fn: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
    _reg.stale_hooks.append(fn)
    return lambda: _reg.stale_hooks.remove(fn) if fn in _reg.stale_hooks else None


def fire_stale_jobs(alert: dict[str, Any]) -> None:
    _log.error("queued jobs not picked up for over 1 h (no registered handler?)", extra=alert)
    for h in list(_reg.stale_hooks):
        try:
            h(alert)
        except Exception:  # noqa: BLE001
            _log.exception("stale-job hook failed")


def registries() -> _Registries:
    return _reg


def reset_registries_for_testing() -> None:
    global _reg
    _reg = _Registries()
