"""M02 unit tests (knowledge plane): cron, backoff, rate limiter, registries.

Database-backed acceptance tests (exactly-once enqueue, retry/dead-letter, scheduler
double-fire) live in apps/web/src/modules/m02_queue/queue.test.ts; both planes share the SQL.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from kp.m01_platform import KpError
from kp.m02_queue import (
    BACKOFF_CAP_MS,
    backoff_ms,
    cron_matches,
    next_fire,
    parse_cron,
    previous_fire,
    register_handler,
    register_schedule,
    reset_registries_for_testing,
    subscribe,
    take_token,
)
from kp.m02_queue.worker import _iso_ms


def utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def test_cron_parse_and_match() -> None:
    s = parse_cron("*/15 9-17 * JAN-MAR MON-FRI")
    assert sorted(s.minutes) == [0, 15, 30, 45]
    assert sorted(s.days_of_week) == [1, 2, 3, 4, 5]
    both = parse_cron("0 0 1 * MON")
    assert cron_matches(both, utc("2026-09-01T00:00:00Z"))
    assert cron_matches(both, utc("2026-09-07T00:00:00Z"))
    assert not cron_matches(both, utc("2026-09-08T00:00:00Z"))
    for bad in ["* * * *", "60 * * * *", "5-1 * * * *", "*/0 * * * *"]:
        with pytest.raises(KpError):
            parse_cron(bad)


def test_previous_and_next_fire_match_ts() -> None:
    s = parse_cron("30 2 * * *")
    now = utc("2026-09-25T10:00:10Z")
    assert previous_fire(s, now, utc("2026-09-24T00:00:00Z")) == utc("2026-09-25T02:30:00Z")
    assert previous_fire(s, now, utc("2026-09-25T02:30:00Z")) is None
    assert next_fire(s, now) == utc("2026-09-26T02:30:00Z")
    assert previous_fire(parse_cron("@monthly"), now, utc("2026-01-15T00:00:00Z")) == utc("2026-09-01T00:00:00Z")
    # Idempotency keys must be byte-identical to JS Date.toISOString().
    assert _iso_ms(utc("2026-09-25T02:30:00Z")) == "2026-09-25T02:30:00.000Z"


def test_backoff() -> None:
    assert backoff_ms(1, 0.5) == 10_000
    assert backoff_ms(1, 0.0) == 8_000
    assert backoff_ms(1, 1.0) == 12_000
    assert backoff_ms(40, 0.5) == BACKOFF_CAP_MS


def test_rate_limiter_fallback() -> None:
    class FakeRedis:
        def __init__(self) -> None:
            self.store: dict[str, str] = {}

        def set(self, k: str, v: str, px: int | None = None, nx: bool = False) -> bool | None:
            if nx and k in self.store:
                return None
            self.store[k] = v
            return True

    r = FakeRedis()
    assert take_token(r, "vendor.x", 2, now_ms=1_000)
    assert not take_token(r, "vendor.x", 2, now_ms=1_100)
    assert take_token(r, "vendor.x", 2, now_ms=1_500)


def test_registries_reject_duplicates() -> None:
    reset_registries_for_testing()
    register_handler("kp.test", None, lambda p, m: None)
    with pytest.raises(KpError):
        register_handler("kp.test", None, lambda p, m: None)
    subscribe("buyer.updated", "reindex", lambda p, m: None)
    with pytest.raises(KpError):
        subscribe("buyer.updated", "reindex", lambda p, m: None)
    register_schedule("nightly", "0 1 * * *", "kp.test", {}, "knowledge")
    with pytest.raises(KpError):
        register_schedule("nightly", "0 2 * * *", "kp.test", {}, "knowledge")
    reset_registries_for_testing()
