/**
 * M16 — response cache for GET /api/markets (LLD M16: "cached for 1 h per (hs6, dataYear)").
 *
 * The data year of a code is only known after reading M14, so the cache is two-level:
 *   m16:markets:v1:ptr:<rowKey>              → "<dataYear>" | "none"      (TTL 1 h)
 *   m16:markets:v1:<rowKey>:<dataYear>       → cached payload JSON         (TTL 1 h)
 * When the knowledge plane publishes a new data year, the next miss writes a new payload key and
 * the old one simply expires.
 *
 * Shorter TTLs [tunable] apply to answers that are expected to improve soon: payloads where some
 * "why" summaries are still being generated lazily, and empty answers.
 *
 * Redis (M01) is used when initialised; otherwise a small bounded in-process map. Cache errors are
 * never fatal: a failed read is a miss and a failed write is logged.
 */
import { getRedis, log, type RedisLike } from '../m01_platform/index.js';
import type { MarketRowDto } from './types.js';

export const CACHE_TTL_SEC = 3600;
/** Payloads with missing "why" summaries (being generated lazily by M14). [tunable] */
export const CACHE_TTL_PENDING_WHY_SEC = 300;
/** Empty answers (no Comtrade rows for the code). [tunable] */
export const CACHE_TTL_EMPTY_SEC = 900;
const PREFIX = 'm16:markets:v1';
const MEMORY_MAX_ENTRIES = 500;

/** What is cached: everything except the per-request `version` echo and guidance. */
export interface CachedMarkets {
  code: string;
  rowsVersion: string | null;
  dataYear: number | null;
  rows: MarketRowDto[];
}

export interface MarketCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
}

class MemoryStore implements MarketCacheStore {
  private readonly map = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    if (this.map.size >= MEMORY_MAX_ENTRIES && !this.map.has(key)) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  }
}

class RedisStore implements MarketCacheStore {
  constructor(private readonly redis: RedisLike) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSec);
  }
}

const memory = new MemoryStore();
let override: MarketCacheStore | undefined;

export function setMarketCacheStoreForTesting(store: MarketCacheStore | undefined): void {
  override = store;
}

function store(): MarketCacheStore {
  if (override) return override;
  try {
    return new RedisStore(getRedis());
  } catch {
    // Redis is not initialised (tests, local tooling): use the in-process map.
    return memory;
  }
}

function pointerKey(rowKey: string): string {
  return `${PREFIX}:ptr:${rowKey}`;
}

function payloadKey(rowKey: string, dataYear: number | 'none'): string {
  return `${PREFIX}:${rowKey}:${dataYear}`;
}

function isCached(v: unknown): v is CachedMarkets {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.code === 'string' &&
    (o.rowsVersion === null || typeof o.rowsVersion === 'string') &&
    (o.dataYear === null || typeof o.dataYear === 'number') &&
    Array.isArray(o.rows)
  );
}

export async function readCachedMarkets(rowKey: string): Promise<CachedMarkets | null> {
  try {
    const s = store();
    const ptr = await s.get(pointerKey(rowKey));
    if (ptr === null) return null;
    const year: number | 'none' = ptr === 'none' ? 'none' : Number.parseInt(ptr, 10);
    if (year !== 'none' && !Number.isInteger(year)) return null;
    const raw = await s.get(payloadKey(rowKey, year));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCached(parsed) ? parsed : null;
  } catch (err) {
    log.warn({ err, rowKey }, 'm16: market cache read failed; treating as a miss');
    return null;
  }
}

export function ttlFor(value: CachedMarkets): number {
  if (value.rows.length === 0) return CACHE_TTL_EMPTY_SEC;
  if (value.rows.some((r) => r.why === null)) return CACHE_TTL_PENDING_WHY_SEC;
  return CACHE_TTL_SEC;
}

export async function writeCachedMarkets(rowKey: string, value: CachedMarkets): Promise<void> {
  const ttl = ttlFor(value);
  const year: number | 'none' = value.dataYear ?? 'none';
  try {
    const s = store();
    // Payload first, so a reader that sees the pointer always finds the payload.
    await s.set(payloadKey(rowKey, year), JSON.stringify(value), ttl);
    await s.set(pointerKey(rowKey), String(year), ttl);
  } catch (err) {
    log.warn({ err, rowKey }, 'm16: market cache write failed');
  }
}
