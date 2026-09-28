/**
 * M39 — anti-scrape controls for buyer search (LLD M39 #3). REQ-004, REQ-051.
 *
 *   - Per-account search-page cap: 200/day on Free, 2000/day on paid [tunable] (config.ts).
 *   - Sequential-page velocity detection: more than `threshold` search calls in `windowSec`
 *     (default 30 in 5 minutes) requires a Cloudflare Turnstile challenge before continuing.
 *
 * M26 (buyer search) was built before this module and does not call an account-level guard
 * (only the anonymous-visitor guard, M05 `guardAnonymous`). Per the pipeline's rule not to
 * rewrite an earlier module's files, this guard is additive: `guardAccountSearchPage()` is a
 * standalone function that a hardened route wrapper calls before `M26.searchBuyers` (see
 * routes.ts) — this module does not edit m26_buyer_search's own files.
 *
 * [deviation: M05's own Redis-backed sliding-window store (`m05_identity/rateLimit.ts`) is not
 * exported from that module's public API (only the in-memory test double and the interface
 * types are), and the public `RedisLike` interface (M01) exposes only get/set/del/quit — not
 * ZADD/EVAL — so the atomic Lua-script path M05 uses internally is not reachable from outside
 * M05. This guard therefore uses the same get/set JSON-log fallback M05's own
 * `KvSlidingWindowStore` uses when EVAL is unavailable: correct for the abuse-detection bar this
 * control needs to clear, but not atomic across concurrent requests for the same account — an
 * acceptable trade-off for a soft anti-scrape brake, the same one M05 itself accepts on that
 * fallback path.]
 */
import { AppError, getRedis, getSecret, hasSecret, log, rateLimited, type ActorContext, type RedisLike } from '../m01_platform/index.js';
import type { HttpRequestLike } from '../m05_identity/index.js';
import { launchHardeningConfig } from './config.js';

export const SECRET_TURNSTILE = 'TURNSTILE_SECRET_KEY';

export type TurnstileVerifier = (token: string, ip: string) => Promise<boolean>;

/** Cloudflare Turnstile siteverify (mirrors M05 guard.ts's own copy; see the module deviation note). */
export const cloudflareTurnstile: TurnstileVerifier = async (token, ip) => {
  const form = new URLSearchParams({ secret: getSecret(SECRET_TURNSTILE), response: token, remoteip: ip });
  let res: Response;
  try {
    res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(8_000),
    });
  } catch (e) {
    throw new AppError('UPSTREAM_UNAVAILABLE', 'Turnstile unreachable', { vendor: 'turnstile' }, { cause: e });
  }
  if (!res.ok) throw new AppError('UPSTREAM_UNAVAILABLE', `Turnstile returned HTTP ${res.status}`, { vendor: 'turnstile' });
  const body = (await res.json().catch(() => ({}))) as { success?: unknown };
  return body.success === true;
};

let verifier: TurnstileVerifier | undefined;

function turnstile(): TurnstileVerifier | undefined {
  if (verifier) return verifier;
  return hasSecret(SECRET_TURNSTILE) ? cloudflareTurnstile : undefined;
}

export function setAntiScrapeTurnstileVerifier(v: TurnstileVerifier | undefined): void {
  verifier = v;
}

function tokenFrom(req: HttpRequestLike | undefined): string | undefined {
  if (!req) return undefined;
  for (const h of ['cf-turnstile-response', 'x-turnstile-token']) {
    const v = req.headers[h];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string' && s.length > 0 && s.length <= 2048) return s;
  }
  return undefined;
}

function clientIpOf(req: HttpRequestLike | undefined): string {
  if (!req) return 'unknown';
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/** Paid = any plan above Free (Starter, Growth). Anonymous is handled by M05's own guard, not this one. */
export function isPaidPlan(plan: ActorContext['entitlements']['plan']): boolean {
  return plan === 'starter' || plan === 'growth';
}

export function dailyCapFor(ctx: ActorContext): number {
  const cfg = launchHardeningConfig().antiScrape.dailySearchPageCap;
  return isPaidPlan(ctx.entitlements.plan) ? cfg.paid : cfg.free;
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function msToNextUtcMidnight(d: Date): number {
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1000, next - d.getTime());
}

interface KvLog {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
}

/** Reads today's count for the account; does not consume. */
async function peekDailyCount(kv: KvLog, accountId: string, now: Date): Promise<number> {
  const key = `m39:search:day:${accountId}:${utcDateKey(now)}`;
  const raw = await kv.get(key);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Increments today's count for the account (best-effort; see the module deviation note). */
async function incrementDailyCount(kv: KvLog, accountId: string, now: Date): Promise<number> {
  const key = `m39:search:day:${accountId}:${utcDateKey(now)}`;
  const current = await peekDailyCount(kv, accountId, now);
  const next = current + 1;
  await kv.set(key, String(next), 'PX', msToNextUtcMidnight(now));
  return next;
}

const VELOCITY_LOG_PX_MS = (windowSec: number): number => windowSec * 1000 * 2;

/** Reads and prunes the account's recent search-call timestamps (does not append `now`). */
async function recentCallTimestamps(kv: KvLog, accountId: string, windowSec: number, now: Date): Promise<number[]> {
  const key = `m39:search:velocity:${accountId}`;
  const raw = await kv.get(key);
  let arr: number[] = [];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed.filter((x): x is number => typeof x === 'number');
    } catch (err) {
      log.warn({ err, accountId }, 'm39: discarding corrupt velocity log');
    }
  }
  return arr.filter((t) => t > now.getTime() - windowSec * 1000);
}

async function appendCallTimestamp(kv: KvLog, accountId: string, windowSec: number, kept: number[], now: Date): Promise<void> {
  const key = `m39:search:velocity:${accountId}`;
  const next = [...kept, now.getTime()];
  await kv.set(key, JSON.stringify(next), 'PX', VELOCITY_LOG_PX_MS(windowSec));
}

const passKey = (accountId: string): string => `m39:search:challenge_pass:${accountId}`;

async function requireChallenge(redis: RedisLike, accountId: string, req: HttpRequestLike | undefined, passTtlSec: number): Promise<void> {
  if ((await redis.get(passKey(accountId))) !== null) return;
  const v = turnstile();
  if (!v) {
    log.warn({ accountId }, 'm39: Turnstile not configured; velocity challenge step skipped');
    return;
  }
  const token = tokenFrom(req);
  if (!token) throw rateLimited(1, 'Please complete the challenge to keep searching', { challenge: true });
  const ip = clientIpOf(req);
  let ok: boolean;
  try {
    ok = await v(token, ip);
  } catch (err) {
    // Degrade: the hard daily cap still applies, so a Turnstile outage does not lock out real users.
    log.warn({ err, accountId }, 'm39: Turnstile verification unavailable; allowing within the daily cap');
    return;
  }
  if (!ok) throw rateLimited(1, 'Challenge failed; please try again', { challenge: true });
  await redis.set(passKey(accountId), '1', 'EX', passTtlSec);
}

/**
 * Guard for `POST /api/buyers/search` for signed-in accounts (LLD M39 #3). No-op for anonymous
 * visitors (M05 `guardAnonymous` already covers them) and for system/admin actors.
 *
 * Throws RATE_LIMITED:
 *   - `details.reason = 'daily_cap'` once the account's plan-based daily page cap is used up.
 *   - `details.challenge = true` once more than `threshold` search calls have been made in the
 *     velocity window and no Turnstile pass is on file; the caller must retry with a
 *     `cf-turnstile-response` / `x-turnstile-token` header.
 */
export async function guardAccountSearchPage(ctx: ActorContext, req?: HttpRequestLike): Promise<void> {
  if (ctx.kind !== 'user' || !ctx.accountId) return;
  const cfg = launchHardeningConfig().antiScrape;
  const redis = getRedis();
  const now = new Date();

  const used = await peekDailyCount(redis, ctx.accountId, now);
  const cap = dailyCapFor(ctx);
  if (used >= cap) {
    const retryAfterSec = Math.ceil(msToNextUtcMidnight(now) / 1000);
    throw rateLimited(retryAfterSec, 'Daily search limit reached', { reason: 'daily_cap', cap });
  }

  const recent = await recentCallTimestamps(redis, ctx.accountId, cfg.velocity.windowSec, now);
  if (recent.length >= cfg.velocity.threshold) {
    await requireChallenge(redis, ctx.accountId, req, cfg.challengePassTtlSec);
  }

  await Promise.all([incrementDailyCount(redis, ctx.accountId, now), appendCallTimestamp(redis, ctx.accountId, cfg.velocity.windowSec, recent, now)]);
}
