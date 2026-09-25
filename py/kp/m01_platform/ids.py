"""UUIDv7 generation (RFC 9562), matching the TS implementation."""
from __future__ import annotations

import os
import threading
import time
import uuid

_lock = threading.Lock()
_last_ms = -1
_counter = 0


def uuid7(now_ms: int | None = None) -> uuid.UUID:
    global _last_ms, _counter
    with _lock:
        ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
        if ms <= _last_ms:
            ms = _last_ms
            _counter += 1
            if _counter > 0xFFF:
                ms = _last_ms + 1
                _counter = 0
        else:
            _counter = int.from_bytes(os.urandom(2), "big") & 0x7FF
        _last_ms = ms
        counter = _counter
    rand_b = int.from_bytes(os.urandom(8), "big") & ((1 << 62) - 1)
    value = (ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= (counter & 0xFFF) << 64
    value |= 0b10 << 62
    value |= rand_b
    return uuid.UUID(int=value)


def new_id() -> str:
    return str(uuid7())
