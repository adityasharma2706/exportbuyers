/**
 * M43 Money-back requests — shared types (LLD M43).
 */

// ---- eligibility -------------------------------------------------------------------------------

/** `FORBIDDEN {reasonKey}` on an ineligible request (LLD M43). */
export type MoneyBackIneligibleReasonKey = 'no_paid_payment' | 'window_expired';

// ---- IF-43a wire DTOs ----------------------------------------------------------------------------

export interface RequestMoneyBackRequest {
  reason: string;
}

export interface RequestMoneyBackResponseDto {
  reviewItemId: string;
  status: 'filed';
}

// ---- M11 'billing.money_back' review type -------------------------------------------------------

/** serving.review_item.payload for `billing.money_back` (LLD M43: "Files billing.money_back
 * (dedupe per payment)"). No new schema table: everything the outcome handler needs travels in
 * this payload, the same shape M31's `removal.request` uses. */
export interface MoneyBackPayload {
  accountId: string;
  /** M36's serving.payment.id — the first captured payment this request is against. */
  paymentId: string;
  razorpayPaymentId: string;
  amountPaise: number;
  reason: string;
  /** Resolved at filing time (LLD M43's own outcomes need "an email to the user"); null when the
   * account has no usable email address at filing time (soft-fails the email step, never the
   * request itself — same posture as M41's notify()). */
  requesterEmail: string | null;
  requestedAt: string;
}

export type MoneyBackOutcome = 'approve' | 'reject';
export const MONEY_BACK_OUTCOMES: readonly MoneyBackOutcome[] = ['approve', 'reject'];

/** IF-11b outcomeSchema data. `reasonKey` is required for `reject` (LLD: "Outcome reject
 * {reasonKey}"); ignored for `approve`. */
export interface MoneyBackOutcomeData {
  reasonKey?: string;
}

// ---- read-only lookups into M36's serving.payment (see repo.ts header) --------------------------

export interface PaymentLookupRow {
  id: string;
  razorpayPaymentId: string;
  amountPaise: number;
  status: string;
  createdAt: Date;
}
