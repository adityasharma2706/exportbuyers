/**
 * M05 — sliding-window rate limits (LLD M05: "Redis sliding windows").
 *
 * A sliding-window log per key: each allowed hit is a sorted-set member scored by its
 * timestamp. A check covers several keys at once and is all-or-nothing, so exceeding any one
 * window (e.g. per-destination) never consumes quota in another (e.g. per-IP).
 *
 * The production store runs one Lua script (atomic in Redis). M01's RedisLike type does not
 * declare EVAL, so the script is used when the concrete client provides it (ioredis does);
 * otherwise a get/set JSON log is used, which is correct for a single process only.
 */
import { randomBytes } from 'node:crypto';
import { AppError, getRedis, log, type RedisLike } from '../m01_platform/index.js';

export interface WindowSpec {
  key: string;
  limit: number;
  windowSec: number;
}

export interface WindowResult {
  allowed: boolean;
  /** Hits in each window after this call (or at the time of refusal). */
  counts: number[];
  /** When refused: seconds until the first blocking window frees a slot. */
  retryAfterSec: number;
  /** Index into specs of the window that refused, or -1. */
  blockedBy: number;
}

export interface SlidingWindowStore {
  /** When consume=false the windows are only inspected. */
  hit(specs: readonly WindowSpec[], nowMs: number, consume: boolean): Promise<WindowResult>;
}

const LUA = `
local now = tonumber(ARGV[1])
local member = ARGV[2]
local consume = tonumber(ARGV[3])
local n = #KEYS
local counts = {}
for i = 1, n do
  local win = tonumber(ARGV[2 + i * 2])
  local limit = tonumber(ARGV[3 + i * 2])
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - win)
  local c = redis.call('ZCARD', KEYS[i])
  counts[i] = c
  if c >= limit then
    local oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    local retry = win
    if oldest[2] then retry = win - (now - tonumber(oldest[2])) end
    return {0, i, retry, unpack(counts)}
  end
end
if consume == 1 then
  for i = 1, n do
    local win = tonumber(ARGV[2 + i * 2])
    redis.call('ZADD', KEYS[i], now, member)
    redis.call('PEXPIRE', KEYS[i], win)
    counts[i] = counts[i] + 1
  end
end
return {1, 0, 0, unpack(counts)}
`;

interface EvalCapable {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

function hasEval(r: RedisLike): r is RedisLike & EvalCapable {
  return typeof (r as unknown as { eval?: unknown }).eval === 'function';
}

function validate(specs: readonly WindowSpec[]): void {
  if (specs.length === 0) throw new AppError('INTERNAL', 'rate limit check needs at least one window');
  for (const s of specs) {
    if (!s.key || !Number.isInteger(s.limit) || s.limit < 1 || !(s.windowSec > 0)) {
      throw new AppError('INTERNAL', `invalid rate limit window for key ${s.key}`);
    }
  }
}

function member(nowMs: number): string {
  return `${nowMs}-${randomBytes(6).toString('hex')}`;
}

export class RedisSlidingWindowStore implements SlidingWindowStore {
  constructor(private readonly redis: () => RedisLike = getRedis) {}

  async hit(specs: readonly WindowSpec[], nowMs: number, consume: boolean): Promise<WindowResult> {
    validate(specs);
    const r = this.redis();
    if (hasEval(r)) {
      const args: Array<string | number> = [nowMs, member(nowMs), consume ? 1 : 0];
      for (const s of specs) args.push(s.windowSec * 1000, s.limit);
      const raw = await r.eval(LUA, specs.length, ...specs.map((s) => s.key), ...args);
      if (!Array.isArray(raw) || raw.length < 3) throw new AppError('INTERNAL', 'unexpected rate-limit script reply');
      const nums = raw.map((x) => Number(x));
      const allowed = nums[0] === 1;
      const blockedIdx = nums[1]! - 1;
      return {
        allowed,
        counts: nums.slice(3),
        retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil(nums[2]! / 1000)),
        blockedBy: allowed ? -1 : blockedIdx,
      };
    }
    return new KvSlidingWindowStore(r).hit(specs, nowMs, consume);
  }
}

/**
 * Fallback over plain GET/SET (JSON array of timestamps). Not atomic across processes; used
 * only when the Redis client lacks EVAL (test fakes).
 */
export class KvSlidingWindowStore implements SlidingWindowStore {
  constructor(private readonly kv: Pick<RedisLike, 'get' | 'set'>) {}

  async hit(specs: readonly WindowSpec[], nowMs: number, consume: boolean): Promise<WindowResult> {
    validate(specs);
    const logs: number[][] = [];
    for (const s of specs) {
      const raw = await this.kv.get(s.key);
      let arr: number[] = [];
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) arr = parsed.filter((x): x is number => typeof x === 'number');
        } catch (err) {
          log.warn({ err, key: s.key }, 'discarding corrupt rate-limit log');
        }
      }
      logs.push(arr.filter((t) => t > nowMs - s.windowSec * 1000));
    }
    for (let i = 0; i < specs.length; i += 1) {
      const s = specs[i]!;
      const l = logs[i]!;
      if (l.length >= s.limit) {
        const oldest = Math.min(...l);
        return {
          allowed: false,
          counts: logs.map((x) => x.length),
          retryAfterSec: Math.max(1, Math.ceil((s.windowSec * 1000 - (nowMs - oldest)) / 1000)),
          blockedBy: i,
        };
      }
    }
    if (consume) {
      for (let i = 0; i < specs.length; i += 1) {
        const s = specs[i]!;
        logs[i]!.push(nowMs);
        await this.kv.set(s.key, JSON.stringify(logs[i]), 'PX', s.windowSec * 1000);
      }
    }
    return { allowed: true, counts: logs.map((x) => x.length), retryAfterSec: 0, blockedBy: -1 };
  }
}

/** In-memory store for tests and single-process tools. */
export class MemorySlidingWindowStore implements SlidingWindowStore {
  private readonly data = new Map<string, number[]>();

  async hit(specs: readonly WindowSpec[], nowMs: number, consume: boolean): Promise<WindowResult> {
    validate(specs);
    const logs = specs.map((s) => (this.data.get(s.key) ?? []).filter((t) => t > nowMs - s.windowSec * 1000));
    for (let i = 0; i < specs.length; i += 1) {
      const s = specs[i]!;
      const l = logs[i]!;
      if (l.length >= s.limit) {
        return {
          allowed: false,
          counts: logs.map((x) => x.length),
          retryAfterSec: Math.max(1, Math.ceil((s.windowSec * 1000 - (nowMs - Math.min(...l))) / 1000)),
          blockedBy: i,
        };
      }
    }
    specs.forEach((s, i) => {
      if (consume) logs[i]!.push(nowMs);
      this.data.set(s.key, logs[i]!);
    });
    return { allowed: true, counts: logs.map((x) => x.length), retryAfterSec: 0, blockedBy: -1 };
  }
}

let store: SlidingWindowStore | undefined;

export function rateStore(): SlidingWindowStore {
  if (!store) store = new RedisSlidingWindowStore();
  return store;
}

export function setRateStore(s: SlidingWindowStore): void {
  store = s;
}
