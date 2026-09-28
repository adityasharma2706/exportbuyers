/**
 * M43 — the M11 (IF-11b) review type this module owns: `billing.money_back`.
 *
 *   approve  -> LLD M43 Outcomes, in order:
 *                 1. Razorpay refund (idempotent via `receipt`; razorpayRefund.ts).
 *                 2. Cancel the subscription immediately (M36 `cancelSubscription`).
 *                 3. M28 `adjustment` removing the remaining granted credits for the period.
 *                 4. Email to the user.
 *   reject {reasonKey} -> email to the user.
 *
 * Call registerMoneyBackReviewType() once at boot (web and worker), before M02's
 * syncRegistrations(). registerMoneyBackModule() (jobs.ts) does this.
 */
import { z } from 'zod';
import { AppError, isAppError, log } from '../m01_platform/index.js';
import { NonRetryable, type Tx } from '../m02_queue/index.js';
import { DEFAULT_SLA_HOURS, registerType, type ReviewItem } from '../m11_review/index.js';
import { grant } from '../m28_credits/index.js';
import { cancelSubscription } from '../m36_billing/index.js';
import { enqueueNotify } from './notify.js';
import { razorpayRefundClient } from './razorpayRefund.js';
import { computeActivePlanGrantRemaining, findActivePlanGrant, markPaymentRefunded } from './repo.js';
import { systemCtxFor } from './systemCtx.js';
import type { MoneyBackOutcomeData, MoneyBackPayload } from './types.js';

export const MONEY_BACK_TYPE = 'billing.money_back';

const moneyBackPayloadSchema: z.ZodType<MoneyBackPayload, z.ZodTypeDef, unknown> = z.object({
  accountId: z.string().uuid(),
  paymentId: z.string().uuid(),
  razorpayPaymentId: z.string().min(1).max(100),
  amountPaise: z.number().int().min(1),
  reason: z.string().min(1).max(500),
  requesterEmail: z.string().email().nullable(),
  requestedAt: z.string(),
});

const moneyBackOutcomeSchema: z.ZodType<MoneyBackOutcomeData, z.ZodTypeDef, unknown> = z.object({
  reasonKey: z.string().min(1).max(100).optional(),
});

/**
 * LLD M43 approve step 2. M36's `cancelSubscription` requires an active (non-terminal)
 * subscription and throws NOT_FOUND otherwise (LLD M36's own `NON_TERMINAL` guard) — a money-back
 * approval reached after the account already cancelled its own subscription is not an error here,
 * it just has nothing left to cancel, so NOT_FOUND is swallowed and every other error propagates
 * (letting M11 retry the handler, LLD M11 Rules).
 */
async function cancelSubscriptionIfActive(accountId: string): Promise<void> {
  try {
    await cancelSubscription(systemCtxFor(accountId), { atPeriodEnd: false });
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') {
      log.info({ accountId }, 'm43: no active subscription to cancel on money-back approval; already cancelled');
      return;
    }
    throw e;
  }
}

/** LLD M43 approve step 3. A no-op when nothing (or nothing unspent) remains to remove. */
async function removeRemainingGrantedCredits(tx: Tx, item: ReviewItem<MoneyBackPayload>): Promise<void> {
  const accountId = item.payload.accountId;
  const activeGrant = await findActivePlanGrant(tx, accountId);
  if (!activeGrant) return;
  const remaining = await computeActivePlanGrantRemaining(tx, accountId, activeGrant);
  if (remaining <= 0) return;

  await grant(systemCtxFor(accountId), {
    accountId,
    credits: -remaining,
    kind: 'adjustment',
    idempotencyKey: `moneyback:${item.id}:adjustment`,
    reason: 'money-back approved: removing the remaining granted credits for the period',
  });
}

async function onApprove(item: ReviewItem<MoneyBackPayload>, tx: Tx): Promise<void> {
  const p = item.payload;

  // 1. Razorpay refund (idempotent via `receipt`; see razorpayRefund.ts).
  const refund = await razorpayRefundClient().refundPayment(p.razorpayPaymentId, p.amountPaise, `moneyback:${item.id}`, {
    accountId: p.accountId,
    reviewItemId: item.id,
  });
  await markPaymentRefunded(tx, p.paymentId);

  // 2. Cancel the subscription immediately.
  await cancelSubscriptionIfActive(p.accountId);

  // 3. M28 adjustment removing the remaining granted credits for the period.
  await removeRemainingGrantedCredits(tx, item);

  // 4. Email to the user.
  if (p.requesterEmail) {
    await enqueueNotify(tx, {
      to: p.requesterEmail,
      templateKey: 'money_back.approved',
      params: { amountPaise: p.amountPaise, razorpayRefundId: refund.id },
      idempotencyKey: `${item.id}:approve`,
    });
  } else {
    log.warn({ itemId: item.id, accountId: p.accountId }, 'm43: money-back approved but the account has no email address on file');
  }
}

async function onReject(item: ReviewItem<MoneyBackPayload>, data: MoneyBackOutcomeData, tx: Tx): Promise<void> {
  if (!data.reasonKey) throw new NonRetryable('billing.money_back: reject needs data.reasonKey');
  const p = item.payload;
  if (!p.requesterEmail) {
    log.warn({ itemId: item.id, accountId: p.accountId }, 'm43: money-back rejected but the account has no email address on file');
    return;
  }
  await enqueueNotify(tx, {
    to: p.requesterEmail,
    templateKey: 'money_back.rejected',
    params: { reasonKey: data.reasonKey },
    idempotencyKey: `${item.id}:reject`,
  });
}

async function onMoneyBackOutcome(item: ReviewItem<MoneyBackPayload>, outcome: string, data: MoneyBackOutcomeData, tx: Tx): Promise<void> {
  if (outcome === 'approve') {
    await onApprove(item, tx);
    return;
  }
  if (outcome === 'reject') {
    await onReject(item, data, tx);
    return;
  }
  throw new AppError('INTERNAL', `billing.money_back: unexpected outcome "${outcome}"`, { itemId: item.id });
}

let registered = false;

/** Registers the `billing.money_back` review type. Idempotent. */
export function registerMoneyBackReviewType(): void {
  if (registered) return;
  registerType<MoneyBackPayload, MoneyBackOutcomeData>({
    type: MONEY_BACK_TYPE,
    payloadSchema: moneyBackPayloadSchema,
    outcomes: ['approve', 'reject'],
    outcomeSchema: moneyBackOutcomeSchema,
    slaHours: DEFAULT_SLA_HOURS.moneyBack,
    // Actual money movement (a Razorpay refund) and an immediate subscription cancellation, so
    // this follows LLD M11 RBAC's "admin_super has everything, including refunds above the cap" —
    // the same bar M30 sets for `report.refund_exception`, its own real-money-adjacent outcome.
    requiredRole: 'admin_super',
    view: {
      titleKey: 'm43.review.moneyBack.title',
      fields: [
        { path: 'accountId', labelKey: 'm43.review.moneyBack.accountId' },
        { path: 'amountPaise', labelKey: 'm43.review.moneyBack.amountPaise', format: 'money' },
        { path: 'reason', labelKey: 'm43.review.moneyBack.reason' },
        { path: 'requesterEmail', labelKey: 'm43.review.moneyBack.requesterEmail', format: 'email' },
        { path: 'requestedAt', labelKey: 'm43.review.moneyBack.requestedAt', format: 'datetime' },
      ],
      outcomeLabelKeys: { approve: 'm43.review.moneyBack.approve', reject: 'm43.review.moneyBack.reject' },
      confirmOutcomes: ['approve', 'reject'],
    },
    onOutcome: onMoneyBackOutcome,
    rejectingOutcomes: ['reject'],
  });
  registered = true;
}

/** Test hook. */
export function resetMoneyBackReviewTypeForTesting(): void {
  registered = false;
}
