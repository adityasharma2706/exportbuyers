/**
 * M36 — shared types for plans, subscriptions, payments, invoices and billing details.
 */
import type { Entitlements } from '../m01_platform/index.js';

export type PlanKey = 'free' | 'starter' | 'growth';
export const PLAN_KEYS: readonly PlanKey[] = ['free', 'starter', 'growth'];
export function isPlanKey(v: unknown): v is PlanKey {
  return typeof v === 'string' && (PLAN_KEYS as readonly string[]).includes(v);
}

export type Cycle = 'monthly' | 'annual';
export const CYCLES: readonly Cycle[] = ['monthly', 'annual'];
export function isCycle(v: unknown): v is Cycle {
  return typeof v === 'string' && (CYCLES as readonly string[]).includes(v);
}

export type SubscriptionStatus = 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'cancelled' | 'completed';
export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'cancelled',
  'completed',
];
export function isSubscriptionStatus(v: unknown): v is SubscriptionStatus {
  return typeof v === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(v);
}

export type PaymentStatus = 'captured' | 'failed' | 'refunded';

// ---- plan catalogue (/config/plans.yaml) ---------------------------------------------------

/** Entitlements minus the `plan` discriminator, which the catalogue key itself supplies. */
export type PlanEntitlements = Omit<Entitlements, 'plan'>;

export interface PlanDefinition {
  key: PlanKey;
  priceInrMonthly: number;
  priceInrAnnual: number;
  /** null for the Free plan, which never has a Razorpay subscription. */
  razorpayPlanId: { monthly: string; annual: string } | null;
  monthlyCredits: number;
  entitlements: PlanEntitlements;
}

export interface PlansCatalogue {
  version: string;
  plans: Record<PlanKey, PlanDefinition>;
}

// ---- rows -----------------------------------------------------------------------------------

export interface SubscriptionRow {
  id: string;
  accountId: string;
  plan: PlanKey;
  cycle: Cycle;
  razorpaySubId: string | null;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentRow {
  id: string;
  accountId: string;
  razorpayPaymentId: string;
  amountPaise: number;
  status: PaymentStatus;
  invoiceId: string | null;
  createdAt: Date;
}

export interface InvoiceRow {
  id: string;
  accountId: string;
  number: string;
  gstin: string | null;
  placeOfSupply: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  pdfS3Key: string | null;
  issuedAt: Date;
}

export interface BillingDetailsRow {
  accountId: string;
  legalName: string;
  gstin: string | null;
  stateCode: string;
  address: string;
  updatedAt: Date;
}

export interface WebhookEventRow {
  razorpayEventId: string;
  type: string;
  payload: unknown;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface BillingMismatchInput {
  id: string;
  accountId: string | null;
  razorpaySubId: string;
  localStatus: string;
  remoteStatus: string;
}

// ---- events -----------------------------------------------------------------------------------

/** EV-10 payload, published on `subscription.changed` (LLD M36 "Webhook rules" / IF-36c). */
export interface SubscriptionChangedPayload {
  v: 1;
  accountId: string;
}

declare module '../m02_queue/types.js' {
  interface EventRegistry {
    'subscription.changed': SubscriptionChangedPayload;
  }
}
