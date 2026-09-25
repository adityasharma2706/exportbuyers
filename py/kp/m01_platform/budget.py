"""M01 vendor budget flag check for Python connectors.

The hourly budget job runs on the TS side (apps/web m01_platform/budget.ts) and sets
``budget:exceeded:<vendor>`` in Redis at 100 % of the monthly limit. Python connectors call
``assert_vendor_budget(vendor)`` before a paid call.
"""
from __future__ import annotations

from typing import Any

from .errors import KpError
from .logs import get_logger
from .secrets import get_secret

BUDGET_EXCEEDED_PREFIX = "budget:exceeded:"
_log = get_logger("kp.m01_platform.budget")
_client: Any = None


def _redis() -> Any:
    global _client
    if _client is None:
        import redis

        _client = redis.Redis.from_url(get_secret("REDIS_URL"), socket_timeout=2, decode_responses=True)
    return _client


def set_redis_for_testing(client: Any) -> None:
    global _client
    _client = client


def is_budget_exceeded(vendor: str) -> bool:
    return _redis().get(BUDGET_EXCEEDED_PREFIX + vendor) is not None


def assert_vendor_budget(vendor: str) -> None:
    """Raises UPSTREAM_UNAVAILABLE when the vendor's budget is exhausted.

    Fails open (logs, allows the call) if Redis is unreachable, matching the TS behaviour.
    """
    try:
        exceeded = is_budget_exceeded(vendor)
    except Exception:
        _log.exception("budget flag check failed; allowing call", extra={"vendor": vendor})
        return
    if exceeded:
        raise KpError(
            "UPSTREAM_UNAVAILABLE",
            f"{vendor} is temporarily unavailable",
            {"vendor": vendor, "reason": "budget_exceeded"},
        )
