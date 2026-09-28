/**
 * M36 — background jobs (LLD M36 "Webhook rules" / "Other rules"):
 *
 *   m36.process_webhook  the heavy work behind POST /webhooks/razorpay ("Return 200 within 5 s.
 *                        Heavy work runs as a job."). Dispatches on the stored webhook_event's
 *                        `type`:
 *                          subscription.activated / subscription.charged
 *                            -> set status+period, grant the plan's monthly credits via M28
 *                               (idempotency key 'plan:<sub>:<period_start>', expiring at
 *                               period_end + 30 d [tunable]), emit EV-10.
 *                          payment.captured
 *                            -> record the payment, create the GST invoice.
 *                          subscription.halted / subscription.cancelled
 *                            -> set status (entitlements.ts derives the Free fallback from it),
 *                               emit EV-10.
 *   m36.reconcile        daily: re-fetches recently-touched subscriptions from Razorpay and files
 *                        a mismatch when the local and remote status disagree.
 *
 * Call registerBillingJobs() once at worker boot (registerBillingEntitlementsProvider() too).
 */
import { log, newId, systemDb, type ActorContext, type Entitlements } from '../m01_platform/index.js';
import { emit, registerHandler, registerSchedule, type PayloadSchema } from '../m02_queue/index.js';
import { grant } from '../m28_credits/index.js';
import { EV_SUBSCRIPTION_CHANGED } from '../m10_policy/index.js';
import { billingConfig } from './config.js';
import { invalidateEntitlementsCache } from './entitlements.js';
import { systemExec } from './exec.js';
import { createInvoiceForPayment } from './invoices.js';
import { isCycle, isPlanKey, monthlyCreditsFor } from './plans.js';
import { razorpay } from './razorpay.js';
import {
  findSubscriptionByRazorpayId,
  getWebhookEvent,
  insertBillingMismatch,
  insertPaymentIfNew,
  listRecentlyTouchedSubscriptions,
  markWebhookProcessed,
  upsertSubscriptionFromWebhook,
} from './repo.js';
import type { Cycle, PlanKey, SubscriptionStatus } from './types.js';
import { SUBSCRIPTION_STATUSES } from './types.js';

export const PROCESS_WEBHOOK_JOB = 'm36.process_webhook';
export const RECONCILE_JOB = 'm36.reconcile';

const SYSTEM_ENTITLEMENTS: Entitlements = {
  plan: 'anonymous',
  searchResultCap: 0,
  exportRowsPerMonth: 0,
  bulkRevealMax: 0,
  checksPerMonth: 0,
  revealsIncludedPerMonth: 0,
};

const SYSTEM_CTX: ActorContext = {
  kind: 'system',
  entitlements: SYSTEM_ENTITLEMENTS,
  locale: 'en',
  region: 'IN',
  mfaVerified: false,
  correlationId: 'm36-scheduler',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function epochToDate(v: number | undefined): Date | null {
  return v === undefined ? null : new Date(v * 1000);
}

function toSubscriptionStatus(s: string | undefined): SubscriptionStatus {
  return s !== undefined && (SUBSCRIPTION_STATUSES as readonly string[]).includes(s) ? (s as SubscriptionStatus) : 'created';
}

interface SubscriptionEntityView {
  id: string;
  status: SubscriptionStatus;
  currentStart: Date | null;
  currentEnd: Date | null;
  accountId: string | null;
  plan: PlanKey | null;
  cycle: Cycle | null;
}

/** Extracts payload.subscription.entity from a Razorpay webhook body, tolerating unknown shapes. */
function subscriptionEntityOf(payload: unknown): SubscriptionEntityView | null {
  if (!isRecord(payload)) return null;
  const p = payload.payload;
  if (!isRecord(p)) return null;
  const sub = p.subscription;
  if (!isRecord(sub)) return null;
  const entity = sub.entity;
  if (!isRecord(entity)) return null;
  const id = str(entity.id);
  if (!id) return null;
  const notes = isRecord(entity.notes) ? entity.notes : {};
  const accountId = str(notes.accountId) ?? null;
  const planRaw = str(notes.plan);
  const cycleRaw = str(notes.cycle);
  return {
    id,
    status: toSubscriptionStatus(str(entity.status)),
    currentStart: epochToDate(num(entity.current_start)),
    currentEnd: epochToDate(num(entity.current_end)),
    accountId,
    plan: planRaw && isPlanKey(planRaw) ? planRaw : null,
    cycle: cycleRaw && isCycle(cycleRaw) ? cycleRaw : null,
  };
}

interface PaymentEntityView {
  id: string;
  amountPaise: number;
  accountId: string | null;
  subscriptionId: string | null;
}

function paymentEntityOf(payload: unknown): PaymentEntityView | null {
  if (!isRecord(payload)) return null;
  const p = payload.payload;
  if (!isRecord(p)) return null;
  const pay = p.payment;
  if (!isRecord(pay)) return null;
  const entity = pay.entity;
  if (!isRecord(entity)) return null;
  const id = str(entity.id);
  const amount = num(entity.amount);
  if (!id || amount === undefined) return null;
  const notes = isRecord(entity.notes) ? entity.notes : {};
  return {
    id,
    amountPaise: amount,
    accountId: str(notes.accountId) ?? null,
    subscriptionId: str(entity.subscription_id) ?? null,
  };
}

/** EV-10: bumps M10's/our own entitlements cache and emits `subscription.changed`. The webhook
 * job (this file) is a plain M02 job, not an M02 `subscribe()` handler, so there is no ambient
 * transaction to piggyback on; the outbox insert gets its own short systemDb transaction, same as
 * subscriptions.ts's self-service cancel path. */
async function emitSubscriptionChanged(accountId: string): Promise<void> {
  invalidateEntitlementsCache(accountId);
  await systemDb('m36: emit subscription.changed')
    .transaction()
    .execute(async (trx) => {
      await emit(trx, EV_SUBSCRIPTION_CHANGED, { v: 1, accountId });
    });
}

// ---- subscription.activated / subscription.charged --------------------------------------------

async function handleSubscriptionActivatedOrCharged(payload: unknown): Promise<void> {
  const sub = subscriptionEntityOf(payload);
  if (!sub) {
    log.warn({ payload }, 'm36: subscription.activated/charged webhook had no recognisable subscription entity');
    return;
  }
  const exec = systemExec('subscription activated/charged webhook');
  const existing = await findSubscriptionByRazorpayId(exec, sub.id);
  const accountId = sub.accountId ?? existing?.accountId ?? null;
  const plan = sub.plan ?? existing?.plan ?? null;
  const cycle = sub.cycle ?? existing?.cycle ?? null;
  if (!accountId || !plan || !cycle) {
    log.error({ razorpaySubId: sub.id }, 'm36: cannot resolve accountId/plan/cycle for a subscription webhook');
    return;
  }

  await upsertSubscriptionFromWebhook(
    exec,
    {
      accountId,
      razorpaySubId: sub.id,
      plan,
      cycle,
      status: sub.status === 'created' || sub.status === 'authenticated' || sub.status === 'pending' ? 'active' : sub.status,
      currentPeriodStart: sub.currentStart,
      currentPeriodEnd: sub.currentEnd,
    },
    newId<'subscription'>(),
  );

  if (sub.currentStart && sub.currentEnd) {
    const cfg = billingConfig();
    const expiresAt = new Date(sub.currentEnd.getTime() + cfg.creditsExpiryGraceDays * 24 * 3600 * 1000);
    try {
      await grant(SYSTEM_CTX, {
        accountId,
        credits: monthlyCreditsFor(plan),
        kind: 'grant',
        expiresAt,
        idempotencyKey: `plan:${sub.id}:${sub.currentStart.toISOString()}`,
        reason: `m36 plan credits (${plan}/${cycle})`,
      });
    } catch (err) {
      log.error({ err, accountId, razorpaySubId: sub.id }, 'm36: failed to grant plan credits for a subscription period');
      throw err; // retryable: the job will retry rather than silently under-granting credits
    }
  }

  await emitSubscriptionChanged(accountId);
}

// ---- payment.captured ---------------------------------------------------------------------

async function handlePaymentCaptured(payload: unknown): Promise<void> {
  const pay = paymentEntityOf(payload);
  if (!pay) {
    log.warn({ payload }, 'm36: payment.captured webhook had no recognisable payment entity');
    return;
  }
  const exec = systemExec('payment captured webhook');

  let accountId = pay.accountId;
  let plan: PlanKey | null = null;
  let cycle: Cycle | null = null;
  if (pay.subscriptionId) {
    const sub = await findSubscriptionByRazorpayId(exec, pay.subscriptionId);
    if (sub) {
      accountId = accountId ?? sub.accountId;
      plan = sub.plan;
      cycle = sub.cycle;
    }
  }
  if (!accountId) {
    // Not one of our subscriptions (e.g. a future M46 top-up order payment) — nothing for M36 to do.
    log.info({ razorpayPaymentId: pay.id }, 'm36: payment.captured webhook not attributable to a subscription; skipping');
    return;
  }

  const { row } = await insertPaymentIfNew(exec, {
    id: newId<'payment'>(),
    accountId,
    razorpayPaymentId: pay.id,
    amountPaise: pay.amountPaise,
    status: 'captured',
  });
  // insertPaymentIfNew is idempotent on razorpay_payment_id, but a *retry* of this same job (e.g.
  // after createInvoiceForPayment threw last time) must still be able to create the invoice, so
  // "already processed" is judged by whether an invoice was actually linked, not by whether the
  // payment row already existed.
  if (row.invoiceId) return;

  if (plan && cycle) {
    await exec.transaction(async (tx) => {
      await createInvoiceForPayment(tx, { accountId: accountId!, paymentId: row.id, amountPaise: pay.amountPaise, plan: plan!, cycle: cycle! });
    });
  } else {
    log.warn({ razorpayPaymentId: pay.id, accountId }, 'm36: payment captured without a resolvable plan/cycle; no invoice was created');
  }
}

// ---- subscription.halted / subscription.cancelled ----------------------------------------------

async function handleSubscriptionHaltedOrCancelled(payload: unknown): Promise<void> {
  const sub = subscriptionEntityOf(payload);
  if (!sub) {
    log.warn({ payload }, 'm36: subscription.halted/cancelled webhook had no recognisable subscription entity');
    return;
  }
  const exec = systemExec('subscription halted/cancelled webhook');
  const existing = await findSubscriptionByRazorpayId(exec, sub.id);
  const accountId = sub.accountId ?? existing?.accountId ?? null;
  const plan = sub.plan ?? existing?.plan ?? null;
  const cycle = sub.cycle ?? existing?.cycle ?? null;
  if (!accountId || !plan || !cycle) {
    log.error({ razorpaySubId: sub.id }, 'm36: cannot resolve accountId/plan/cycle for a halt/cancel webhook');
    return;
  }
  await upsertSubscriptionFromWebhook(
    exec,
    {
      accountId,
      razorpaySubId: sub.id,
      plan,
      cycle,
      status: sub.status,
      currentPeriodStart: sub.currentStart ?? existing?.currentPeriodStart ?? null,
      currentPeriodEnd: sub.currentEnd ?? existing?.currentPeriodEnd ?? null,
    },
    newId<'subscription'>(),
  );
  await emitSubscriptionChanged(accountId);
}

// ---- job registration ---------------------------------------------------------------------

interface ProcessWebhookPayload {
  v: 1;
  eventId: string;
}

const processWebhookSchema: PayloadSchema<ProcessWebhookPayload> = {
  safeParse(input: unknown) {
    if (!isRecord(input) || input.v !== 1 || typeof input.eventId !== 'string' || input.eventId.length === 0) {
      return { success: false as const, error: { message: 'payload must be {v:1, eventId: string}' } };
    }
    return { success: true as const, data: { v: 1, eventId: input.eventId } };
  },
};

const v1Schema: PayloadSchema<{ v: 1 }> = {
  safeParse(input: unknown) {
    if (isRecord(input) && input.v === 1) return { success: true as const, data: { v: 1 as const } };
    return { success: false as const, error: { message: 'payload must be {v:1}' } };
  },
};

/** Runs the heavy work for one already-stored webhook_event row. Exported for tests. */
export async function processWebhookEvent(eventId: string): Promise<void> {
  const exec = systemExec('process webhook event');
  const row = await getWebhookEvent(exec, eventId);
  if (!row) {
    log.warn({ eventId }, 'm36: process_webhook job ran for an unknown webhook_event id');
    return;
  }
  if (row.processedAt) return; // already handled (a retried/duplicate job)

  switch (row.type) {
    case 'subscription.activated':
    case 'subscription.charged':
      await handleSubscriptionActivatedOrCharged(row.payload);
      break;
    case 'payment.captured':
      await handlePaymentCaptured(row.payload);
      break;
    case 'subscription.halted':
    case 'subscription.cancelled':
      await handleSubscriptionHaltedOrCancelled(row.payload);
      break;
    default:
      log.info({ eventId, type: row.type }, 'm36: unhandled Razorpay webhook type');
  }
  await markWebhookProcessed(exec, eventId);
}

/** Daily reconciliation (LLD M36 "Other rules"). Exported for tests. */
export async function reconcileSubscriptions(): Promise<{ checked: number; mismatches: number }> {
  const cfg = billingConfig();
  const exec = systemExec('daily reconciliation');
  const rows = await listRecentlyTouchedSubscriptions(exec, cfg.reconcileLookbackHours, cfg.reconcileMaxSubscriptions);
  let mismatches = 0;
  for (const row of rows) {
    if (!row.razorpaySubId) continue;
    try {
      const remote = await razorpay().fetchSubscription(row.razorpaySubId);
      const remoteStatus = toSubscriptionStatus(remote.status);
      if (remoteStatus !== row.status) {
        await insertBillingMismatch(exec, {
          id: newId<'billing_mismatch'>(),
          accountId: row.accountId,
          razorpaySubId: row.razorpaySubId,
          localStatus: row.status,
          remoteStatus,
        });
        log.error({ accountId: row.accountId, razorpaySubId: row.razorpaySubId, localStatus: row.status, remoteStatus }, 'm36: billing.mismatch');
        mismatches++;
      }
    } catch (err) {
      log.warn({ err, razorpaySubId: row.razorpaySubId }, 'm36: reconciliation could not fetch a subscription from Razorpay');
    }
  }
  return { checked: rows.length, mismatches };
}

let registered = false;

export function registerBillingJobs(): void {
  if (registered) return;

  registerHandler(PROCESS_WEBHOOK_JOB, processWebhookSchema, async (p) => {
    await processWebhookEvent(p.eventId);
  });

  registerHandler(RECONCILE_JOB, v1Schema, async () => {
    const r = await reconcileSubscriptions();
    log.info(r, 'm36: reconciliation pass complete');
  });
  registerSchedule('m36-reconcile', '30 20 * * *', RECONCILE_JOB, { v: 1 }, 'serving');

  registered = true;
}
