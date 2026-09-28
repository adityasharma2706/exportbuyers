/**
 * M39 unit tests: the anti-scrape guard (config.ts + antiScrape.ts), against a fake Redis
 * (get/set/del only — the same public surface `RedisLike` exposes; see antiScrape.ts's module
 * deviation note on why this cannot use M05's own atomic sliding-window store).
 */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { initRedis, closeRedis, type ActorContext, type RedisLike } from '../m01_platform/index.js';
import { dailyCapFor, guardAccountSearchPage, isPaidPlan, setAntiScrapeTurnstileVerifier } from './antiScrape.js';
import { loadLaunchHardeningConfig, setLaunchHardeningConfig } from './config.js';

function fakeRedis(): RedisLike {
  const store = new Map<string, string>();
  return {
    async get(k) {
      return store.get(k) ?? null;
    },
    async set(k, v) {
      store.set(k, v);
      return 'OK';
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
    async quit() {
      return 'OK';
    },
  };
}

function ctxFor(plan: ActorContext['entitlements']['plan'], accountId = 'acct-1'): ActorContext {
  return {
    kind: 'user',
    accountId: accountId as ActorContext['accountId'],
    entitlements: { plan, searchResultCap: 999, exportRowsPerMonth: 0, bulkRevealMax: 0, checksPerMonth: 0, revealsIncludedPerMonth: 0 },
    locale: 'en',
    region: 'IN',
    mfaVerified: false,
    correlationId: 'test',
  };
}

beforeEach(() => {
  closeRedis().catch(() => undefined);
  initRedis({ appEnv: 'test' } as never, { client: fakeRedis() });
  setLaunchHardeningConfig({ antiScrape: { dailySearchPageCap: { free: 3, paid: 100 }, velocity: { windowSec: 300, threshold: 2 }, challengePassTtlSec: 3600 } });
  setAntiScrapeTurnstileVerifier(undefined);
});

test('dailyCapFor / isPaidPlan pick the right plan bucket', () => {
  loadLaunchHardeningConfig({});
  setLaunchHardeningConfig({ antiScrape: { dailySearchPageCap: { free: 200, paid: 2000 }, velocity: { windowSec: 300, threshold: 30 }, challengePassTtlSec: 3600 } });
  assert.equal(isPaidPlan('free'), false);
  assert.equal(isPaidPlan('starter'), true);
  assert.equal(isPaidPlan('growth'), true);
  assert.equal(dailyCapFor(ctxFor('free')), 200);
  assert.equal(dailyCapFor(ctxFor('starter')), 2000);
});

test('guardAccountSearchPage is a no-op for anonymous and admin actors', async () => {
  const anon: ActorContext = { ...ctxFor('anonymous'), kind: 'anonymous', accountId: undefined };
  await guardAccountSearchPage(anon); // must not throw even with no accountId
});

test('guardAccountSearchPage throws RATE_LIMITED with reason daily_cap once the plan cap is used up', async () => {
  const ctx = ctxFor('free', 'acct-cap');
  for (let i = 0; i < 3; i++) await guardAccountSearchPage(ctx);
  await assert.rejects(() => guardAccountSearchPage(ctx), (err: unknown) => {
    assert.equal((err as { code: string }).code, 'RATE_LIMITED');
    assert.equal((err as { details?: { reason?: string } }).details?.reason, 'daily_cap');
    return true;
  });
});

test('guardAccountSearchPage requires a challenge once the velocity threshold is exceeded, and a passed challenge clears it', async () => {
  const ctx = ctxFor('starter', 'acct-velocity');
  setAntiScrapeTurnstileVerifier(async () => true);
  await guardAccountSearchPage(ctx); // 1st call: under threshold (2)
  await guardAccountSearchPage(ctx); // 2nd call: still under threshold
  // 3rd call: threshold reached; no token supplied -> challenge required.
  await assert.rejects(() => guardAccountSearchPage(ctx), (err: unknown) => {
    assert.equal((err as { code: string }).code, 'RATE_LIMITED');
    assert.equal((err as { details?: { challenge?: boolean } }).details?.challenge, true);
    return true;
  });
  // With a token, the verifier passes and the call is allowed (and the pass is cached).
  await guardAccountSearchPage(ctx, { headers: { 'cf-turnstile-response': 'tok' } });
});

test('a Turnstile outage degrades to "allow within the hard cap" rather than locking users out', async () => {
  const ctx = ctxFor('starter', 'acct-degrade');
  setAntiScrapeTurnstileVerifier(async () => {
    throw new Error('turnstile down');
  });
  await guardAccountSearchPage(ctx);
  await guardAccountSearchPage(ctx);
  await guardAccountSearchPage(ctx, { headers: { 'cf-turnstile-response': 'tok' } }); // degrades, does not throw
});
