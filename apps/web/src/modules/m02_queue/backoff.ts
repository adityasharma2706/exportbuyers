/**
 * M02 — retry backoff: min(2^attempts × 5 s, 1 h) with ±20% jitter.
 * `attempts` is the number of attempts already made (1 after the first failure).
 */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 3_600_000;
export const BACKOFF_JITTER = 0.2;

/** @param random a value in [0, 1); injectable for tests. */
export function backoffMs(attempts: number, random: number = Math.random()): number {
  const n = Math.max(0, Math.floor(Number.isFinite(attempts) ? attempts : 0));
  // 2^30 × 5 s already exceeds the cap; clamp the exponent so the arithmetic stays finite.
  const raw = Math.min(2 ** Math.min(n, 30) * BACKOFF_BASE_MS, BACKOFF_CAP_MS);
  const r = Math.min(Math.max(random, 0), 1);
  const factor = 1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * r;
  return Math.max(1, Math.round(raw * factor));
}
