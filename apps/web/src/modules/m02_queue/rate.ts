/**
 * M02 — per-vendor rate classes (platform.rate_class).
 *
 *   per_second       enforced with a Redis token bucket per class (burst = max(1, ceil(per_second))).
 *   max_concurrency  enforced by counting running jobs of the class in platform.job (see runtime.ts).
 *
 * When the client supports EVAL (ioredis does) the bucket is an atomic Lua script that uses
 * Redis server time, so worker clock skew does not matter. Clients that only expose the
 * M01 RedisLike surface fall back to a fixed-slot limiter built on SET NX PX: at most one
 * token per 1/per_second interval, which is also atomic but allows no bursting.
 */
import type { RedisLike } from '../m01_platform/index.js';

export interface RateClass {
  name: string;
  maxConcurrency: number;
  perSecond: number;
}

export const RATE_KEY_PREFIX = 'm02:rate:';

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local d = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(burst, tokens + elapsed / 1000 * rate)
local ok = 0
if tokens >= 1 then
  tokens = tokens - 1
  ok = 1
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, math.ceil(burst / rate * 1000) + 1000)
return ok
`;

interface RedisWithEval {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

function hasEval(r: RedisLike): r is RedisLike & RedisWithEval {
  return typeof (r as Partial<RedisWithEval>).eval === 'function';
}

export function burstFor(rc: RateClass): number {
  return Math.max(1, Math.ceil(rc.perSecond));
}

/** Milliseconds between tokens: 1 / per_second. */
export function tokenIntervalMs(rc: RateClass): number {
  return Math.max(1, Math.ceil(1000 / rc.perSecond));
}

/** Tries to take one token for the class. Returns true when the job may run now. */
export async function takeToken(redis: RedisLike, rc: RateClass, nowMs: number = Date.now()): Promise<boolean> {
  if (!(rc.perSecond > 0)) return true;
  const key = RATE_KEY_PREFIX + rc.name;
  if (hasEval(redis)) {
    const res = await redis.eval(TOKEN_BUCKET_LUA, 1, key, String(rc.perSecond), String(burstFor(rc)));
    return Number(res) === 1;
  }
  const interval = tokenIntervalMs(rc);
  const slot = Math.floor(nowMs / interval);
  const res = await redis.set(`${key}:slot:${slot}`, '1', 'PX', interval * 2, 'NX');
  return res === 'OK';
}
