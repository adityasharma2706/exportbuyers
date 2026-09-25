/**
 * M10 — search result cache: per (ctx.accountId, surface, region, queryHash) for 60 s [tunable].
 * The global generation counter `policy:gen` is part of every key; EV-03, EV-04 and EV-10 bump
 * it, which invalidates every cached result at once. A per-account generation lets hide
 * changes invalidate one account's results.
 *
 * Correctness never depends on the cache (HLD): any Redis failure is a miss.
 */
import { createHash } from 'node:crypto';
import { getRedis, log, type ActorContext, type RedisLike } from '../m01_platform/index.js';
import { policyConfig } from './providers.js';
import type { SearchQuery, SearchResult } from './types.js';

export const POLICY_GEN_KEY = 'policy:gen';
const accountGenKey = (accountId: string) => `policy:gen:acct:${accountId}`;

function redisOrNull(): RedisLike | null {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = canonical(x);
    }
    return out;
  }
  return v;
}

export function queryHash(q: SearchQuery): string {
  return createHash('sha256').update(JSON.stringify(canonical(q))).digest('hex').slice(0, 32);
}

function newGen(): string {
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
}

/** Invalidates every cached policy result (EV-03 / EV-04 / EV-10 and suppress()). */
export async function bumpPolicyGen(): Promise<void> {
  const r = redisOrNull();
  if (!r) return;
  try {
    await r.set(POLICY_GEN_KEY, newGen());
  } catch (err) {
    log.warn({ err }, 'm10 failed to bump policy:gen');
  }
}

/** Invalidates one account's cached results (e.g. after a hide or plan change). */
export async function invalidateAccountPolicyCache(accountId: string): Promise<void> {
  const r = redisOrNull();
  if (!r) return;
  try {
    await r.set(accountGenKey(accountId), newGen());
  } catch (err) {
    log.warn({ err }, 'm10 failed to bump account policy generation');
  }
}

async function cacheKey(r: RedisLike, ctx: ActorContext, surface: string, q: SearchQuery): Promise<string> {
  const who = ctx.kind === 'anonymous' ? 'anon' : ctx.accountId ? `acct:${ctx.accountId}` : `${ctx.kind}`;
  const [gen, acctGen] = await Promise.all([
    r.get(POLICY_GEN_KEY),
    ctx.accountId && ctx.kind !== 'anonymous' ? r.get(accountGenKey(ctx.accountId)) : Promise.resolve(null),
  ]);
  return `m10:search:${gen ?? '0'}:${acctGen ?? '0'}:${who}:${surface}:${(ctx.region || '--').toUpperCase()}:${queryHash(q)}`;
}

export async function getCachedSearch(ctx: ActorContext, surface: string, q: SearchQuery): Promise<{ key: string | null; hit: SearchResult | null }> {
  const ttl = policyConfig().searchCacheTtlSec;
  const r = redisOrNull();
  if (!r || ttl <= 0) return { key: null, hit: null };
  try {
    const key = await cacheKey(r, ctx, surface, q);
    const raw = await r.get(key);
    return { key, hit: raw ? (JSON.parse(raw) as SearchResult) : null };
  } catch (err) {
    log.warn({ err }, 'm10 search cache read failed');
    return { key: null, hit: null };
  }
}

export async function putCachedSearch(key: string | null, value: SearchResult): Promise<void> {
  const ttl = policyConfig().searchCacheTtlSec;
  const r = redisOrNull();
  if (!r || !key || ttl <= 0) return;
  try {
    await r.set(key, JSON.stringify(value), 'EX', ttl);
  } catch (err) {
    log.warn({ err }, 'm10 search cache write failed');
  }
}
