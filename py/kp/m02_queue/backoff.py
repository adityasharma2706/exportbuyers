"""M02 — retry backoff: min(2^attempts × 5 s, 1 h) with ±20% jitter. Mirror of backoff.ts."""
from __future__ import annotations

import math
import random as _random

BACKOFF_BASE_MS = 5_000
BACKOFF_CAP_MS = 3_600_000
BACKOFF_JITTER = 0.2


def backoff_ms(attempts: int, rnd: float | None = None) -> int:
    """``attempts`` is the number of attempts already made; ``rnd`` in [0, 1) is injectable for tests."""
    n = max(0, int(attempts)) if math.isfinite(attempts) else 0
    raw = min((2 ** min(n, 30)) * BACKOFF_BASE_MS, BACKOFF_CAP_MS)
    r = _random.random() if rnd is None else min(max(rnd, 0.0), 1.0)
    factor = 1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * r
    return max(1, round(raw * factor))
