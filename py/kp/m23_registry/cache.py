"""Result cache for M23 lookups (LLD M23: Redis; registry 30 days, domain 7 days).

A cache failure is never an error for the caller: a Redis outage just means a miss and the
vendor is asked again (still inside its rate class).
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from typing import Any, Callable, Protocol

from kp.m01_platform import get_logger, get_secret

from .models import Result, Unavailable, result_from_dict

REGISTRY_TTL_S = 30 * 24 * 3600      # [tunable] registry and VAT results
DOMAIN_TTL_S = 7 * 24 * 3600         # [tunable] domain signals
PARTIAL_DOMAIN_TTL_S = 3600          # [tunable] domain signals with a failed DNS or RDAP part
KEY_PREFIX = "m23:"

_log = get_logger("kp.m23_registry.cache")


class Cache(Protocol):
    def get(self, key: str) -> str | None: ...
    def set(self, key: str, value: str, ttl_s: int) -> None: ...


class MemoryCache:
    """In-process cache (tests, and the fallback when Redis is not configured)."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._data: dict[str, tuple[float, str]] = {}
        self._clock = clock
        self._lock = threading.Lock()

    def get(self, key: str) -> str | None:
        with self._lock:
            hit = self._data.get(key)
            if hit is None:
                return None
            if hit[0] <= self._clock():
                del self._data[key]
                return None
            return hit[1]

    def set(self, key: str, value: str, ttl_s: int) -> None:
        with self._lock:
            self._data[key] = (self._clock() + ttl_s, value)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


class RedisCache:
    """Redis-backed cache; errors are logged and treated as misses."""

    def __init__(self, client: Any | None = None) -> None:
        self._client = client
        self._lock = threading.Lock()

    def client(self) -> Any:
        with self._lock:
            if self._client is None:
                import redis

                self._client = redis.Redis.from_url(get_secret("REDIS_URL"), socket_timeout=2,
                                                    decode_responses=True)
            return self._client

    def get(self, key: str) -> str | None:
        try:
            v = self.client().get(key)
        except Exception as e:  # noqa: BLE001 — cache is best effort
            _log.warning("m23 cache read failed", extra={"err": type(e).__name__})
            return None
        if v is None:
            return None
        return v.decode("utf-8") if isinstance(v, bytes) else str(v)

    def set(self, key: str, value: str, ttl_s: int) -> None:
        try:
            self.client().set(key, value, ex=int(ttl_s))
        except Exception as e:  # noqa: BLE001 — cache is best effort
            _log.warning("m23 cache write failed", extra={"err": type(e).__name__})


_cache: Cache | None = None
_cache_lock = threading.Lock()


def default_cache() -> Cache:
    global _cache
    with _cache_lock:
        if _cache is None:
            _cache = RedisCache()
        return _cache


def set_cache_for_testing(cache: Cache | None) -> None:
    global _cache
    with _cache_lock:
        _cache = cache


def cache_key(kind: str, *parts: str) -> str:
    """Stable key; free text (names) is hashed so keys stay short and carry no raw input."""
    digest = hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:40]
    return f"{KEY_PREFIX}{kind}:{digest}"


def cache_get(key: str) -> Result | None:
    raw = default_cache().get(key)
    if raw is None:
        return None
    try:
        return result_from_dict(json.loads(raw))
    except (ValueError, TypeError) as e:
        _log.warning("m23 cache entry unreadable; ignored", extra={"err": type(e).__name__})
        return None


def cache_put(key: str, result: Result, ttl_s: int) -> None:
    """``Unavailable`` is never cached: it is transient by definition."""
    if isinstance(result, Unavailable) or ttl_s <= 0:
        return
    default_cache().set(key, json.dumps(result.to_dict(), separators=(",", ":"), default=str), ttl_s)
