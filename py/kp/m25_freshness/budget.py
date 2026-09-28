"""Shared thread pool for per-assertion re-verification (mirrors M24's ``budget.py``).

``reverify()`` (IF-25a) waits at most ``REVERIFY_RPC_WAIT_MS`` for the reveal / report triggers
(LLD M25: "it waits up to reverify_rpc_wait_ms"). A check that has not finished by then is reported
``unknown`` to the caller, but its future keeps running on this pool — Python threads cannot be
killed — so the write it eventually produces still lands (LLD: "the job continues in the
background"). The pool is process-wide and is never shut down with ``wait=True``.
"""
from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor
from concurrent.futures import wait as _wait
from typing import Callable, Iterable, TypeVar

from kp.m01_platform import get_logger

from .models import CHECK_BUDGET_S, MAX_WORKERS

_log = get_logger("kp.m25_freshness.budget")

T = TypeVar("T")

_executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="kp-m25")


def submit(fn: Callable[[], T]) -> "Future[T]":
    """Runs ``fn`` on the shared pool."""
    return _executor.submit(fn)


def wait_all(futures: Iterable["Future[T]"], *, timeout_s: float | None) -> tuple[set["Future[T]"], set["Future[T]"]]:
    """``(done, not_done)`` after waiting at most ``timeout_s`` (``None`` = wait to completion)."""
    return _wait(list(futures), timeout=timeout_s)


def result_or(fut: "Future[T]", *, on_error: Callable[[BaseException], T]) -> T:
    """The future's result, or ``on_error(exc)`` if it raised. Must only be called on a done future."""
    try:
        return fut.result(timeout=0)
    except BaseException as e:  # noqa: BLE001 — a check must never take the whole run down
        _log.info("re-verification check failed", extra={"error": type(e).__name__})
        return on_error(e)


__all__ = ["CHECK_BUDGET_S", "FIRST_COMPLETED", "result_or", "submit", "wait_all"]
