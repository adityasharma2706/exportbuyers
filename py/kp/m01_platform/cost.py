"""M01 per-vendor cost metrics (IF-01b, Python mirror).

``record_cost(...)`` buffers events in memory; a daemon thread flushes them to
``platform.cost_event`` every 5 s [tunable]. It never raises for I/O problems, only
``KpError('VALIDATION')`` for programmer errors (bad names, non-integer money).
"""
from __future__ import annotations

import atexit
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Callable, Sequence

from .config import get_config
from .errors import KpError
from .ids import new_id
from .logs import current_correlation_id, get_logger
from .secrets import get_secret

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,63}$")
_log = get_logger("kp.m01_platform.cost")


@dataclass(frozen=True)
class CostRow:
    id: str
    vendor: str
    op: str
    units: Decimal
    cost_micros_inr: int
    job_type: str | None
    account_id: str | None
    credit_ref: str | None
    correlation_id: str
    at: datetime


CostSink = Callable[[Sequence[CostRow]], None]

_INSERT_SQL = (
    "insert into platform.cost_event (id, vendor, op, units, cost_micros_inr, job_type, account_id, "
    "credit_ref, correlation_id, at) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
)


def _db_sink(rows: Sequence[CostRow]) -> None:
    import psycopg

    with psycopg.connect(get_secret("DATABASE_URL"), autocommit=False) as conn:
        with conn.cursor() as cur:
            cur.executemany(
                _INSERT_SQL,
                [
                    (r.id, r.vendor, r.op, r.units, r.cost_micros_inr, r.job_type, r.account_id, r.credit_ref,
                     r.correlation_id, r.at)
                    for r in rows
                ],
            )
        conn.commit()


_lock = threading.Lock()
_flush_lock = threading.Lock()
_buffer: list[CostRow] = []
_dropped = 0
_sink: CostSink = _db_sink
_thread: threading.Thread | None = None
_stop = threading.Event()


def set_cost_sink_for_testing(sink: CostSink | None) -> None:
    global _sink
    _sink = sink or _db_sink


def record_cost(
    *,
    vendor: str,
    op: str,
    units: float | int | Decimal,
    cost_micros_inr: int,
    account_id: str | None = None,
    correlation_id: str | None = None,
    job_type: str | None = None,
    credit_ref: str | None = None,
) -> None:
    global _dropped
    if not _NAME_RE.match(vendor):
        raise KpError("VALIDATION", f"record_cost: invalid vendor {vendor!r}")
    if not _NAME_RE.match(op):
        raise KpError("VALIDATION", f"record_cost: invalid op {op!r}")
    if job_type is not None and not _NAME_RE.match(job_type):
        raise KpError("VALIDATION", f"record_cost: invalid job_type {job_type!r}")
    if isinstance(cost_micros_inr, bool) or not isinstance(cost_micros_inr, int) or cost_micros_inr < 0:
        raise KpError("VALIDATION", "record_cost: cost_micros_inr must be a non-negative int (micro-INR)")
    u = Decimal(str(units))
    if not u.is_finite() or u < 0:
        raise KpError("VALIDATION", "record_cost: units must be finite and >= 0")
    if credit_ref is not None and not 0 < len(credit_ref) <= 200:
        raise KpError("VALIDATION", "record_cost: credit_ref must be 1..200 chars")

    row = CostRow(
        id=new_id(),
        vendor=vendor,
        op=op,
        units=u,
        cost_micros_inr=cost_micros_inr,
        job_type=job_type,
        account_id=account_id,
        credit_ref=credit_ref,
        correlation_id=correlation_id or current_correlation_id() or "none",
        at=datetime.now(timezone.utc),
    )
    cap = get_config().cost_max_buffered
    with _lock:
        if len(_buffer) >= cap:
            _buffer.pop(0)
            _dropped += 1
        _buffer.append(row)
    _ensure_thread()


def flush_costs() -> None:
    """Writes all buffered events; on failure they are re-queued (bounded)."""
    global _buffer, _dropped
    with _flush_lock:
        with _lock:
            batch, _buffer = _buffer, []
            dropped, _dropped = _dropped, 0
        if dropped:
            _log.warning("cost events dropped due to full buffer", extra={"dropped": dropped})
        if not batch:
            return
        try:
            for i in range(0, len(batch), 500):
                _sink(batch[i : i + 500])
        except Exception:
            cap = get_config().cost_max_buffered
            with _lock:
                merged = batch + _buffer
                overflow = max(0, len(merged) - cap)
                _dropped += overflow
                _buffer = merged[overflow:]
                pending = len(_buffer)
            _log.exception("cost flush failed; will retry", extra={"pending": pending})


def pending_cost_events() -> int:
    with _lock:
        return len(_buffer)


def _run() -> None:
    interval = get_config().cost_flush_interval_s
    while not _stop.wait(interval):
        flush_costs()


def _ensure_thread() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        _stop.clear()
        _thread = threading.Thread(target=_run, name="kp-cost-flusher", daemon=True)
        _thread.start()


def stop_cost_recorder() -> None:
    global _thread
    _stop.set()
    t = _thread
    _thread = None
    if t is not None:
        t.join(timeout=10)
    flush_costs()


atexit.register(stop_cost_recorder)
