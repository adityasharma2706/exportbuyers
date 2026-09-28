/**
 * M29 Contact reveal — shared types (LLD M29 "Schema" / "API (IF-29a/b)").
 */
import type { Entitlements } from '../m01_platform/index.js';

export type ContactKind = 'website' | 'phone' | 'role_email' | 'form_url' | 'address' | 'whatsapp';
export const CONTACT_KINDS: readonly ContactKind[] = ['website', 'phone', 'role_email', 'form_url', 'address', 'whatsapp'];

/** LLD M25 `DeliverabilityStatus`. */
export type Deliverability = 'valid' | 'risky' | 'invalid' | 'unknown';
export const DELIVERABILITY_STATUSES: readonly Deliverability[] = ['valid', 'risky', 'invalid', 'unknown'];

// ---- serving.reveal / serving.reveal_contact / serving.reveal_bulk row shapes -----------------

export type RevealState = 'pending' | 'done' | 'failed';

export interface RevealRow {
  id: string;
  account_id: string;
  company_id: string;
  state: RevealState;
  hold_id: string | null;
  commit_entry_id: string | null;
  catalogue_version: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RevealContactRow {
  reveal_id: string;
  account_id: string;
  assertion_id: string;
  kind: string;
  value_enc: Buffer;
  deliverability: Deliverability;
  checked_at: Date;
  created_at: Date;
}

export type RevealBulkState = 'queued' | 'running' | 'done' | 'failed';
export type RevealBulkItemStatus = 'done' | 'failed' | 'already';

export interface RevealBulkItem {
  companyId: string;
  status: RevealBulkItemStatus;
  reason?: string;
}

export interface RevealBulkRow {
  id: string;
  account_id: string;
  state: RevealBulkState;
  company_ids: string[];
  confirmed_credits: number;
  results: RevealBulkItem[];
  credits_charged: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

// ---- IF-29a wire DTOs ---------------------------------------------------------------------------

export interface RevealedContactDto {
  assertionId: string;
  kind: string;
  value: string;
  /** 'invalid' is never returned to a client: invalid contacts are excluded before reveal. */
  deliverability: 'valid' | 'risky' | 'unknown';
  checkedAt: string;
  stale: boolean;
}

export interface RevealResponseDto {
  revealId: string;
  contacts: RevealedContactDto[];
  creditsCharged: number;
  /** True when this account had already revealed the company (no new charge). */
  already?: boolean;
}

/** LLD M29 sequence step 6: "Zero deliverable contacts remain ... return {contacts: [],
 * creditsCharged: 0, reason:'NO_VALID_CONTACTS'}." No `revealId` — nothing was recorded. */
export interface NoValidContactsResponseDto {
  contacts: [];
  creditsCharged: 0;
  reason: 'NO_VALID_CONTACTS';
}

export type RevealApiResponse = RevealResponseDto | NoValidContactsResponseDto;

export interface BulkRevealResponseDto {
  bulkId: string;
  state: RevealBulkState;
  results?: RevealBulkItem[];
  creditsCharged?: number;
}

/** IF-29b, used by M35's export job: one already-revealed contact, decrypted. */
export interface RevealedContact {
  companyId: string;
  revealId: string;
  assertionId: string;
  kind: string;
  value: string;
  deliverability: 'valid' | 'risky' | 'unknown';
  checkedAt: Date;
}

// ---- internal working shapes --------------------------------------------------------------------

/** One `ProfileDoc.contacts[]` entry (M10 IF-10a), before values are attached. */
export interface ProfileContactSlot {
  assertion_id: string;
  kind: string;
  source_type: string;
  checked_at: string | null;
  deliverability: string;
}

export interface SlotResolution {
  assertionId: string;
  kind: string;
  deliverability: Deliverability;
  checkedAt: Date;
  stale: boolean;
}

/** A slot resolution that also carries its plaintext contact value (post value-fetch). */
export interface ResolvedContact extends SlotResolution {
  value: string;
}

/** Background-job payload for a large bulk reveal (LLD M29 Bulk: "processed as a job"). */
export interface BulkJobPayload {
  v: 1;
  bulkId: string;
  accountId: string;
  memberId: string;
  workspaceId?: string;
  role?: string;
  region: string;
  locale: 'en' | 'hi';
  mfaVerified: boolean;
  entitlements: Entitlements;
  /** Every company id in the original request, in order (for the final results array). */
  allCompanyIds: string[];
  /** The subset that was already revealed before this request (status 'already'). */
  alreadyRevealedIds: string[];
  /** The subset this job must actually process. */
  toProcess: string[];
  holdId: string;
  unitCredits: number;
  catalogueVersion: string | null;
}
