/**
 * M36 — IF-36c, the entitlements provider registered with M10 (and, so the fallback in M05's
 * session resolution is also correct as soon as this module boots, with M05 too): "get(accountId)
 * -> the plan entitlements when the subscription is active, otherwise Free. Cached for 60 s;
 * EV-10 invalidates the cache." (LLD M36).
 *
 * "Active" here follows the M36 Webhook rules precisely:
 *   - status 'halted'                                  -> Free immediately.
 *   - status 'active' or 'cancelled', now <= period_end -> the plan (a cancelled subscription
 *                                                          still owns the period it was paid for).
 *   - status 'completed', now <= period_end             -> the plan (Razorpay's total_count of
 *                                                          cycles ran out, but the last paid
 *                                                          period has not).
 *   - anything else (created/authenticated/pending, no
 *     row, or the period has ended)                     -> Free.
 */
import { log, type Entitlements, type Id } from '../m01_platform/index.js';
import { registerProvider as registerPolicyProvider } from '../m10_policy/index.js';
import { setEntitlementsProvider as setIdentityEntitlementsProvider } from '../m05_identity/index.js';
import { freeEntitlements, entitlementsForPlan } from './plans.js';
import { findSubscriptionByAccount } from './repo.js';
import { systemExec } from './exec.js';
import type { SubscriptionRow } from './types.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: Entitlements; expiresAt: number }>();

export function invalidateEntitlementsCache(accountId?: string): void {
  if (accountId) cache.delete(accountId);
  else cache.clear();
}

function periodCoversNow(row: SubscriptionRow, now: Date): boolean {
  return row.currentPeriodEnd !== null && now.getTime() <= row.currentPeriodEnd.getTime();
}

function isEffectivelyOnPlan(row: SubscriptionRow, now: Date): boolean {
  if (row.status === 'halted') return false;
  if (row.status === 'active' || row.status === 'cancelled' || row.status === 'completed') {
    return periodCoversNow(row, now);
  }
  return false;
}

async function computeEntitlements(accountId: string): Promise<Entitlements> {
  const exec = systemExec('entitlements lookup for policy/session');
  const row = await findSubscriptionByAccount(exec, accountId);
  if (!row) return freeEntitlements();
  return isEffectivelyOnPlan(row, new Date()) ? entitlementsForPlan(row.plan) : freeEntitlements();
}

/** Cached read (60 s [tunable], LLD M36 IF-36c). */
export async function entitlementsForAccount(accountId: string): Promise<Entitlements> {
  const now = Date.now();
  const cached = cache.get(accountId);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await computeEntitlements(accountId);
  cache.set(accountId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/** Registers M36 as M10's and M05's entitlements provider. Call once at boot, after M10/M05 are
 * initialised and before serving traffic. Idempotent: re-registering just replaces the provider. */
export function registerBillingEntitlementsProvider(): void {
  registerPolicyProvider('entitlements', {
    get: async (accountId: Id<'account'> | string | null) => (accountId === null ? freeEntitlements() : entitlementsForAccount(String(accountId))),
  });
  setIdentityEntitlementsProvider(async (accountId: Id<'account'> | null) =>
    accountId === null ? freeEntitlements() : entitlementsForAccount(String(accountId)),
  );
  log.info({}, 'm36: registered as the entitlements provider for M10 and M05');
}
