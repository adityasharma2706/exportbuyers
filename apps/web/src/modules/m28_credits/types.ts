/**
 * M28 — shared types for the credits ledger, price catalogue and usage history.
 */

export type EntryKind = 'grant' | 'topup' | 'hold' | 'commit' | 'release' | 'refund' | 'expiry' | 'adjustment';
export type EntryBucket = 'available' | 'held' | 'spent' | 'system';
export type AllowanceKind = 'reveal' | 'check';
export type GrantKind = 'grant' | 'topup' | 'adjustment';

/** One row of ledger.entry, mapped to camelCase. */
export interface EntryRow {
  id: string;
  accountId: string;
  txnId: string;
  kind: EntryKind;
  bucket: EntryBucket;
  credits: number;
  actionType: string | null;
  actionRef: string | null;
  catalogueVersion: string | null;
  refersTo: string | null;
  idempotencyKey: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface Balance {
  available: number;
  held: number;
}

export interface HoldParams {
  credits: number;
  actionType: string;
  actionRef?: string | null;
  idempotencyKey: string;
  /** Defaults to the tunable creditsConfig().defaultHoldTtlSec. */
  ttlSec?: number;
}

export interface CommitOptions {
  /** Credits actually consumed; defaults to the full held amount. Must be <= the held amount. */
  credits?: number;
}

export interface CommitResult {
  /** The 'spent'-bucket entry id; pass this as `refersTo` to refund(). */
  commitEntryId: string;
  committed: number;
  /** Any remainder that was returned to available. */
  released: number;
}

export interface RefundParams {
  /** The commitEntryId returned by commit(). */
  refersTo: string;
  credits: number;
  reason: string;
  idempotencyKey: string;
}

export interface RefundResult {
  refundEntryId: string;
  refunded: number;
}

export interface GrantParams {
  accountId: string;
  /** Positive for 'grant'/'topup'; 'adjustment' may be negative to correct an over-grant. */
  credits: number;
  kind: GrantKind;
  expiresAt?: Date | null;
  idempotencyKey: string;
  reason: string;
}

export interface GrantResult {
  grantEntryId: string;
}

export interface QuoteOptions {
  /** ISO-3166 alpha-2; defaults to the actor's region. */
  country?: string;
  quantity?: number;
}

export interface Quote {
  credits: number;
  catalogueVersion: string;
}

// ---------------------------------------------------------------------------------------------
// Usage history (GET /api/credits/history) — wire format: dates are ISO strings so the same
// shape works whether it is built server-side (for SSR) or received from fetch() on the client.
// ---------------------------------------------------------------------------------------------

export interface UsageEntry {
  id: string;
  kind: EntryKind;
  bucket: EntryBucket;
  credits: number;
  actionType: string | null;
  actionRef: string | null;
  catalogueVersion: string | null;
  refersTo: string | null;
  createdAt: string;
}

export interface UsageTxn {
  txnId: string;
  createdAt: string;
  /** Net change to the 'available' bucket for this transaction (the balance-visible effect). */
  netCredits: number;
  entries: UsageEntry[];
}

export interface UsageHistoryPage {
  items: UsageTxn[];
  nextCursor: string | null;
}
