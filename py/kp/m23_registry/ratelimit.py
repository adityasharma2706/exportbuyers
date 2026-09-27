"""Per-vendor rate classes (LLD M23: Companies House 600/5 min, GLEIF 60/min, VIES 1/s [tunable]).

The same class names are registered with M02 (``register_rate_class``) so queued jobs that call a
vendor are throttled by the worker, and on-demand calls take a token from the same Redis bucket
through ``take_token``. If Redis is unreachable an in-process bucket is used instead, so a single
process still never exceeds the vendor's rate.
"""
from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from kp.m01_platform import get_logger, get_secret
from kp.m02_queue import take_token

_log = get_logger("kp.m23_registry.ratelimit")

DEFAULT_MAX_WAIT_S = 3.0  # [tunable] on-demand calls wait at most this long for a token


@dataclass(frozen=True)
class VendorRate:
    rate_class: str
    per_second: float
    max_concurrency: int


# [tunable] — vendor published limits, used as our ceiling.
VENDOR_RATES: dict[str, VendorRate] = {
    "gleif": VendorRate("vendor.gleif", 60 / 60.0, 4),                       # 60 / min
    "companies_house": VendorRate("vendor.companies_house", 600 / 300.0, 4),  # 600 / 5 min
    "vies": VendorRate("vendor.vies", 1.0, 2),                                # 1 / s
    "opencorporates": VendorRate("vendor.opencorporates", 0.2, 1),            # free tier is small
    "rdap": VendorRate("vendor.rdap", 2.0, 4),
    "whois": VendorRate("vendor.whois", 0.5, 2),
    "freemail": VendorRate("vendor.freemail", 0.1, 1),
}


class _LocalBucket:
    def __init__(self, per_second: float, clock: Callable[[], float]) -> None:
        self.per_second = per_second
        self.capacity = float(max(1, math.ceil(per_second)))
        self.tokens = self.capacity
        self.clock = clock
        self.updated = clock()

    def take(self) -> bool:
        now = self.clock()
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.per_second)
        self.updated = now
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return True
        return False


class RateLimiter:
    def __init__(
        self,
        redis_factory: Callable[[], Any] | None = None,
        *,
        rates: dict[str, VendorRate] | None = None,
        max_wait_s: float = DEFAULT_MAX_WAIT_S,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._redis_factory = redis_factory if redis_factory is not None else _default_redis
        self._rates = dict(rates or VENDOR_RATES)
        self._max_wait_s = max_wait_s
        self._sleep = sleep
        self._clock = clock
        self._local: dict[str, _LocalBucket] = {}
        self._lock = threading.Lock()
        self._redis: Any | None = None
        self._redis_failed_at: float | None = None

    def rate(self, vendor: str) -> VendorRate:
        r = self._rates.get(vendor)
        if r is None:
            raise KeyError(f"no rate class for vendor {vendor!r}")
        return r

    def _redis_client(self) -> Any | None:
        # After a failure, stay on the local bucket for 30 s before trying Redis again.
        if self._redis_failed_at is not None and self._clock() - self._redis_failed_at < 30.0:
            return None
        if self._redis is None:
            try:
                self._redis = self._redis_factory()
            except Exception as e:  # noqa: BLE001 — fall back to the local bucket
                _log.warning("rate limiter has no Redis; using in-process bucket", extra={"err": type(e).__name__})
                self._redis_failed_at = self._clock()
                return None
        return self._redis

    def _try_take(self, r: VendorRate) -> bool:
        client = self._redis_client()
        if client is not None:
            try:
                return bool(take_token(client, r.rate_class, r.per_second))
            except Exception as e:  # noqa: BLE001 — fall back to the local bucket
                _log.warning("rate token from Redis failed; using in-process bucket",
                             extra={"rate_class": r.rate_class, "err": type(e).__name__})
                self._redis_failed_at = self._clock()
                self._redis = None
        with self._lock:
            b = self._local.get(r.rate_class)
            if b is None:
                b = self._local[r.rate_class] = _LocalBucket(r.per_second, self._clock)
            return b.take()

    def acquire(self, vendor: str, max_wait_s: float | None = None) -> bool:
        """Waits for a token for ``vendor``; False when none arrived within the wait budget."""
        r = self.rate(vendor)
        budget = self._max_wait_s if max_wait_s is None else max_wait_s
        deadline = self._clock() + budget
        step = min(1.0, max(0.05, 1.0 / r.per_second / 4))
        while True:
            if self._try_take(r):
                return True
            if self._clock() + step > deadline:
                return False
            self._sleep(step)


def _default_redis() -> Any:
    import redis

    return redis.Redis.from_url(get_secret("REDIS_URL"), socket_timeout=2, decode_responses=True)


_limiter: RateLimiter | None = None
_limiter_lock = threading.Lock()


def default_limiter() -> RateLimiter:
    global _limiter
    with _limiter_lock:
        if _limiter is None:
            _limiter = RateLimiter()
        return _limiter


def set_limiter_for_testing(limiter: RateLimiter | None) -> None:
    global _limiter
    with _limiter_lock:
        _limiter = limiter
