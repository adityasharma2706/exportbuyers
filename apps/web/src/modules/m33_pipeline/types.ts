/**
 * M33 — shared types (LLD M33 "Schema" / "API (IF-33a)" / DS-15 ShortlistEntry).
 */
import type { Id } from '../m01_platform/index.js';

/** LLD M33 schema: serving.shortlist_entry.status check constraint. */
export const SHORTLIST_STATUSES = [
  'to_contact',
  'contacted',
  'replied',
  'in_discussion',
  'sample_sent',
  'order_won',
  'not_interested',
] as const;
export type ShortlistStatus = (typeof SHORTLIST_STATUSES)[number];

export const DEFAULT_SHORTLIST_STATUS: ShortlistStatus = 'to_contact';

/** LLD M33 schema: serving.status_history.source check constraint. */
export const STATUS_SOURCES = ['user', 'auto_draft'] as const;
export type StatusSource = (typeof STATUS_SOURCES)[number];

// ---- row shapes (serving.shortlist_entry / serving.status_history / serving.note) -------------
//
// [deviation: the LLD's literal schema for serving.status_history and serving.note carries no
// account_id/workspace_id columns (only entry_id). Both columns are added here, the same
// deviation M29's serving.reveal_contact migration documents for the same reason: M01's tenant
// registry (`scoped()`/RLS) needs a tenant column on every row it touches, and these child rows
// are read and written through this module's own account-scoped request paths (PATCH
// /api/shortlist/:id/notes has no workspace segment in its URL, so a plain per-row account_id
// check — rather than requiring ctx.workspaceId — is what lets a note or status change be found
// by id alone). Primary keys and the columns the LLD does list are unchanged.]

export interface ShortlistEntryRow {
  id: string;
  account_id: string;
  workspace_id: string;
  company_id: string;
  status: ShortlistStatus;
  next_action_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface StatusHistoryRow {
  id: string;
  account_id: string;
  workspace_id: string;
  entry_id: string;
  from_status: ShortlistStatus | null;
  to_status: ShortlistStatus;
  source: StatusSource;
  at: Date;
}

export interface NoteRow {
  id: string;
  account_id: string;
  workspace_id: string;
  entry_id: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

// ---- domain shapes ------------------------------------------------------------------------------

export interface ShortlistEntry {
  id: Id<'shortlist_entry'>;
  accountId: Id<'account'>;
  workspaceId: Id<'workspace'>;
  companyId: Id<'company'>;
  status: ShortlistStatus;
  nextActionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Note {
  id: Id<'note'>;
  entryId: Id<'shortlist_entry'>;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---- IF-33a wire DTOs ---------------------------------------------------------------------------

export interface ShortlistEntryDto {
  id: string;
  workspaceId: string;
  workspaceName?: string;
  /** The current company id (LLD Rules: "reads resolve company ids through the redirect view"). */
  companyId: string;
  status: ShortlistStatus;
  nextActionAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** REQ-045/M10 rule: "sanctions-flagged companies are allowed, and they carry a warning". */
  sanctionsWarning: boolean;
  /** True when another live entry in the same workspace resolved to the same current company
   * (LLD Rules: "two entries that merge into the same company are both shown, with a
   * 'duplicate' hint"). */
  duplicate: boolean;
  notesCount: number;
}

export interface NoteDto {
  id: string;
  entryId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface AddToShortlistDeniedDto {
  companyId: string;
  reason: string;
}

export interface AddToShortlistResponseDto {
  added: ShortlistEntryDto[];
  alreadyPresent: string[];
  denied: AddToShortlistDeniedDto[];
}

export interface ShortlistListResponseDto {
  entries: ShortlistEntryDto[];
}

export interface MyBuyersResponseDto {
  entries: ShortlistEntryDto[];
}

export interface UpdateShortlistStatusInput {
  status?: ShortlistStatus;
  nextActionAt?: string | null;
}

// ---- events (EV-08 PipelineStatusChanged, EV-09 DraftLeftProduct) -------------------------------

/** EV-08 PipelineStatusChanged (HLD §6). Producer: M33. Consumers: M44, M41, M42. */
export const EV_PIPELINE_STATUS_CHANGED = 'pipeline.status_changed';

export interface PipelineStatusChangedPayload {
  v: 1;
  entryId: string;
  accountId: string;
  workspaceId: string;
  companyId: string;
  fromStatus: ShortlistStatus | null;
  toStatus: ShortlistStatus;
  source: StatusSource;
  at: string;
}

/**
 * EV-09 DraftLeftProduct (HLD §6: "copy/mailto/wa.me"). Producer: M34 (not yet built).
 * Consumers: M33 (this module — auto-sets status to Contacted) and M41.
 *
 * [deviation: M34 does not exist yet (it is built after this module), so this event's type
 * name and payload shape are specified here, by its first consumer, following the LLD's own
 * wording ("Setting the same status is a no-op" / DS-16 Draft "left-product-at"). M34 must emit
 * exactly this shape when it lands; `entryId` is DS-16's `entry_id` foreign key into
 * serving.shortlist_entry, which is the join this handler needs.]
 */
export const EV_DRAFT_LEFT_PRODUCT = 'draft.left_product';

export interface DraftLeftProductPayload {
  v: 1;
  entryId: string;
  accountId: string;
  workspaceId: string;
  companyId: string;
  via: 'copy' | 'mailto' | 'wa';
  at: string;
}

declare module '../m02_queue/types.js' {
  interface EventRegistry {
    'pipeline.status_changed': PipelineStatusChangedPayload;
    'draft.left_product': DraftLeftProductPayload;
  }
}
