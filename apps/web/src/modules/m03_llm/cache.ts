/**
 * M03 — response cache (Redis, TTL 30 days).
 *
 * Key: sha256(tier|model|system|messages|jsonSchema|temperature). Only `cacheable: true`
 * requests use it. Cache failures never fail an LLM call; they are logged and skipped.
 * Only schema-valid results are stored.
 */
import { getRedis, log } from '../m01_platform/index.js';
import type { RedisLike } from '../m01_platform/index.js';
import { sha256Hex, stableStringify } from './pii.js';
import type { LlmMessage, LlmResult, Tier } from './types.js';

export const CACHE_PREFIX = 'llm:cache:v1:';

export interface CacheKeyInput {
  tier: Tier;
  model: string;
  system: string;
  messages: LlmMessage[];
  jsonSchema?: object;
  temperature: number;
}

export function llmCacheKey(k: CacheKeyInput): string {
  const parts = [
    k.tier,
    k.model,
    k.system,
    stableStringify(k.messages.map((m) => ({ role: m.role, content: m.content }))),
    k.jsonSchema === undefined ? '' : stableStringify(k.jsonSchema),
    String(k.temperature),
  ];
  return CACHE_PREFIX + sha256Hex(parts.join('|'));
}

type CachedEntry = Omit<LlmResult, 'cached'>;

let override: RedisLike | null | undefined;

/** For tests: supply a fake Redis, `null` to disable caching, or undefined to use M01's client. */
export function setLlmCacheClientForTesting(c: RedisLike | null | undefined): void {
  override = c;
}

function client(): RedisLike | undefined {
  if (override !== undefined) return override ?? undefined;
  try {
    return getRedis();
  } catch {
    return undefined;
  }
}

function isEntry(v: unknown): v is CachedEntry {
  if (v === null || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.text === 'string' && typeof e.model === 'string' && typeof e.inputTokens === 'number' && typeof e.outputTokens === 'number';
}

export async function cacheGet(key: string): Promise<LlmResult | undefined> {
  const c = client();
  if (!c) return undefined;
  try {
    const raw = await c.get(key);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isEntry(parsed)) {
      await c.del(key);
      return undefined;
    }
    return { ...parsed, cached: true };
  } catch (err) {
    log.warn({ err, llmCache: 'get' }, 'llm cache read failed; calling provider');
    return undefined;
  }
}

export async function cachePut(key: string, result: LlmResult, ttlSec: number): Promise<void> {
  const c = client();
  if (!c) return;
  const entry: CachedEntry = {
    text: result.text,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    ...(result.json !== undefined ? { json: result.json } : {}),
  };
  try {
    await c.set(key, JSON.stringify(entry), 'EX', ttlSec);
  } catch (err) {
    log.warn({ err, llmCache: 'set' }, 'llm cache write failed');
  }
}
