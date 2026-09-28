"""Per-vendor-call timeout budget (LLD M24 IF-24b: "each check has a 3 s budget, and a check that
runs out → unknown").

Only pure vendor / network calls are wrapped (registry lookups, domain signals, the homepage
fetch): a check that also writes M09 assertions in the caller's transaction does that write
*outside* the budget, synchronously and un-cancelled, because abandoning a write mid-transaction
on a shared (not thread-safe) database connection would corrupt it. Everything that can genuinely
hang — an outbound HTTP call — is bounded; everything that touches the caller's transaction is
fast (a local DB round trip) and runs to completion. See ``checks.py``.

A single shared thread pool is used (never a fresh ``ThreadPoolExecutor`` per call, and never
``shutdown(wait=True)``): a call that overran its budget keeps running in the background — Python
threads cannot be killed — and its thread is simply left to finish and be discarded, rather than
blocking the caller.
"""
from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Callable, TypeVar

from kp.m01_platform import get_logger

_log = get_logger("kp.m24_trust.budget")

T = TypeVar("T")

CHECK_BUDGET_S = 3.0     # [tunable] LLD M24: per-check vendor budget
RPC_BUDGET_S = 8.0       # [tunable] LLD M24 IF-24b: overall ad hoc RPC timeout
MAX_WORKERS = 32         # [tunable] shared pool size; six checks run concurrently only in ad hoc mode

_executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="kp-m24")


def submit(fn: Callable[[], T]) -> Future[T]:
    """Runs ``fn`` on the shared pool. Use with ``wait_for`` (or a bare ``.result(timeout=...)``)."""
    return _executor.submit(fn)


def wait_for(fut: Future[T], *, budget_s: float, on_timeout: Callable[[], T],
            on_error: Callable[[BaseException], T]) -> T:
    try:
        return fut.result(timeout=budget_s)
    except FutureTimeout:
        _log.info("vendor call exceeded its budget; treated as unavailable", extra={"budget_s": budget_s})
        return on_timeout()
    except BaseException as e:  # noqa: BLE001 — a vendor call must never take the whole run down
        _log.info("vendor call failed; treated as unavailable", extra={"error": type(e).__name__})
        return on_error(e)


def run_with_budget(fn: Callable[[], T], *, budget_s: float = CHECK_BUDGET_S,
                    on_timeout: Callable[[], T], on_error: Callable[[BaseException], T]) -> T:
    """Submits ``fn`` to the shared pool and waits at most ``budget_s`` for it."""
    return wait_for(submit(fn), budget_s=budget_s, on_timeout=on_timeout, on_error=on_error)
