/**
 * M36 — self-service billing actions (LLD M36 "API"): checkout, cancel and payment-method
 * update. Entitlements themselves are never changed here — only from verified, idempotent
 * webhooks (LLD M36 rule); these functions only talk to Razorpay and mirror the resulting
 * subscription id/plan/cycle locally so the webhook has something to update.
 */
import { AppError, getSecret, newId, systemDb, type ActorContext } from '../m01_platform/index.js';
import { emit, type Tx } from '../m02_queue/index.js';
import { EV_SUBSCRIPTION_CHANGED } from '../m10_policy/index.js';
import { billingConfig, SECRET_RAZORPAY_KEY_ID } from './config.js';
import { userExec } from './exec.js';
import { invalidateEntitlementsCache } from './entitlements.js';
import { isCycle, isPlanKey, razorpayPlanId } from './plans.js';
import { razorpay } from './razorpay.js';
import {
  findSubscriptionByAccount,
  setCancelAtPeriodEnd,
  setSubscriptionCancelledNow,
  upsertBillingDetails as repoUpsertBillingDetails,
  getBillingDetails as repoGetBillingDetails,
  upsertFreshSubscription,
} from './repo.js';
import type { BillingDetailsRow, Cycle, PlanKey, SubscriptionRow } from './types.js';

const NON_TERMINAL: readonly SubscriptionRow['status'][] = ['created', 'authenticated', 'active', 'pending'];

export interface CheckoutInput {
  plan: PlanKey;
  cycle: Cycle;
}

export interface CheckoutResult {
  razorpaySubscriptionId: string;
  keyId: string;
}

/** POST /api/billing/checkout {plan, cycle} -> {razorpaySubscriptionId, keyId}. */
export async function checkout(ctx: ActorContext, input: CheckoutInput): Promise<CheckoutResult> {
  if (!isPlanKey(input.plan) || input.plan === 'free') {
    throw new AppError('VALIDATION', 'plan must be "starter" or "growth"', { field: 'plan' });
  }
  if (!isCycle(input.cycle)) throw new AppError('VALIDATION', 'cycle must be "monthly" or "annual"', { field: 'cycle' });
  const { exec, accountId } = userExec(ctx);
  const cfg = billingConfig();
  const keyId = getSecret(SECRET_RAZORPAY_KEY_ID);

  const existing = await findSubscriptionByAccount(exec, accountId);
  if (existing && existing.razorpaySubId && NON_TERMINAL.includes(existing.status)) {
    // Idempotent: a double-submitted checkout returns the subscription already in flight rather
    // than creating a second Razorpay subscription for the same account.
    return { razorpaySubscriptionId: existing.razorpaySubId, keyId };
  }

  const planId = razorpayPlanId(input.plan, input.cycle);
  const totalCount = input.cycle === 'monthly' ? cfg.monthlyTotalCount : cfg.annualTotalCount;
  const sub = await razorpay().createSubscription({
    planId,
    totalCount,
    notes: { accountId, plan: input.plan, cycle: input.cycle },
  });

  await upsertFreshSubscription(exec, {
    id: newId<'subscription'>(),
    accountId,
    plan: input.plan,
    cycle: input.cycle,
    razorpaySubId: sub.id,
    status: isCreatedLikeStatus(sub.status) ? sub.status : 'created',
  });

  return { razorpaySubscriptionId: sub.id, keyId };
}

function isCreatedLikeStatus(s: string): s is 'created' | 'authenticated' | 'pending' {
  return s === 'created' || s === 'authenticated' || s === 'pending';
}

export interface CancelInput {
  atPeriodEnd: boolean;
}

/** POST /api/billing/cancel {atPeriodEnd}. */
export async function cancelSubscription(ctx: ActorContext, input: CancelInput): Promise<{ cancelAtPeriodEnd: boolean; status: string }> {
  const { exec, accountId } = userExec(ctx);
  const row = await findSubscriptionByAccount(exec, accountId);
  if (!row || !row.razorpaySubId || !NON_TERMINAL.includes(row.status)) {
    throw new AppError('NOT_FOUND', 'No active subscription to cancel');
  }

  await razorpay().cancelSubscription(row.razorpaySubId, input.atPeriodEnd);

  if (input.atPeriodEnd) {
    await setCancelAtPeriodEnd(exec, accountId, true);
    return { cancelAtPeriodEnd: true, status: row.status };
  }

  const now = new Date();
  await setSubscriptionCancelledNow(exec, accountId, now);
  invalidateEntitlementsCache(accountId);

  // EV-10, in its own systemDb transaction: ScopedDb (userExec's exec) does not expose the raw
  // Kysely Tx that emit() needs, the same pattern M30's service.ts uses for EV-13. The
  // cancellation row update above and this event are each individually durable and idempotent
  // (M10's onSubscriptionChanged just bumps a cache generation), so the small window between the
  // two commits is harmless — unlike the money-moving M28 writes, which do share one transaction.
  await systemDb('m36: emit subscription.changed (self-service cancel)')
    .transaction()
    .execute(async (tx: Tx) => {
      await emit(tx, EV_SUBSCRIPTION_CHANGED, { v: 1, accountId });
    });

  return { cancelAtPeriodEnd: false, status: 'cancelled' };
}

export interface UpdateMethodResult {
  shortUrl: string;
}

/**
 * POST /api/billing/update-method -> {shortUrl}.
 *
 * [deviation: Razorpay Subscriptions has no separate "update payment method" API endpoint. The
 * subscription's own `short_url` (the hosted page customers use to authorize/re-authorize the
 * UPI AutoPay / card / net-banking mandate) is reused for this purpose, which is the documented
 * Razorpay pattern for a customer who needs to redo authorization.]
 */
export async function requestPaymentMethodUpdate(ctx: ActorContext): Promise<UpdateMethodResult> {
  const { exec, accountId } = userExec(ctx);
  const row = await findSubscriptionByAccount(exec, accountId);
  if (!row || !row.razorpaySubId) throw new AppError('NOT_FOUND', 'No subscription to update');
  const sub = await razorpay().fetchSubscription(row.razorpaySubId);
  if (!sub.short_url) throw new AppError('UPSTREAM_UNAVAILABLE', 'Razorpay did not return an authorization link');
  return { shortUrl: sub.short_url };
}

// ---- billing details (GSTIN capture; LLD M36 deliverables) ------------------------------------
// Not in the LLD's literal API list, which only names checkout/cancel/update-method/webhooks/
// invoices; added because "GSTIN capture" is an explicit M36 deliverable and invoices.ts needs
// somewhere to read it from (LLD schema: serving.billing_details).

export interface BillingDetailsInput {
  legalName: string;
  gstin?: string | null;
  stateCode: string;
  address: string;
}

const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{13}$/;
const STATE_CODE_RE = /^[0-9]{2}$/;

export function parseBillingDetails(body: unknown): BillingDetailsInput {
  if (body === null || typeof body !== 'object') throw new AppError('VALIDATION', 'Request body must be an object');
  const b = body as Record<string, unknown>;
  const legalName = typeof b.legalName === 'string' ? b.legalName.trim() : '';
  if (legalName.length < 1 || legalName.length > 200) throw new AppError('VALIDATION', 'legalName is required', { field: 'legalName' });
  const stateCode = typeof b.stateCode === 'string' ? b.stateCode.trim() : '';
  if (!STATE_CODE_RE.test(stateCode)) throw new AppError('VALIDATION', 'stateCode must be a 2-digit GST state code', { field: 'stateCode' });
  const address = typeof b.address === 'string' ? b.address.trim() : '';
  if (address.length < 1 || address.length > 500) throw new AppError('VALIDATION', 'address is required', { field: 'address' });
  let gstin: string | null = null;
  if (b.gstin !== undefined && b.gstin !== null && b.gstin !== '') {
    const g = String(b.gstin).trim().toUpperCase();
    if (!GSTIN_RE.test(g)) throw new AppError('VALIDATION', 'gstin is not a valid GSTIN', { field: 'gstin' });
    gstin = g;
  }
  return { legalName, gstin, stateCode, address };
}

export async function updateBillingDetails(ctx: ActorContext, input: BillingDetailsInput): Promise<BillingDetailsRow> {
  const { exec, accountId } = userExec(ctx);
  return repoUpsertBillingDetails(exec, { accountId, legalName: input.legalName, gstin: input.gstin ?? null, stateCode: input.stateCode, address: input.address });
}

export async function getMyBillingDetails(ctx: ActorContext): Promise<BillingDetailsRow | null> {
  const { exec, accountId } = userExec(ctx);
  return repoGetBillingDetails(exec, accountId);
}

export function billingDetailsDto(b: BillingDetailsRow): Record<string, unknown> {
  return { legalName: b.legalName, gstin: b.gstin, stateCode: b.stateCode, address: b.address, updatedAt: b.updatedAt.toISOString() };
}
