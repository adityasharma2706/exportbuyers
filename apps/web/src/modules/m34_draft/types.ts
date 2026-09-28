/**
 * M34 — shared types (LLD M34 "Schema" / "API" / IF-34b/IF-34c).
 */
import type { Id } from '../m01_platform/index.js';

/** LLD M34 schema: serving.draft.kind check constraint. This module only ever writes 'first'
 * (its title is "Outreach drafting: first contact"); the other kinds are reserved for a later
 * follow-up-drafting module that reuses this same table without a new migration. */
export const DRAFT_KINDS = ['first', 'follow_up_1', 'follow_up_2', 'whatsapp_intro'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export const FIRST_CONTACT_KIND: DraftKind = 'first';

export const DRAFT_TONES = ['formal', 'friendly'] as const;
export type DraftTone = (typeof DRAFT_TONES)[number];

/** LLD M34 API IF-34c: POST /api/drafts/:id/handoff {via}. */
export const DRAFT_HANDOFF_VIA = ['copy', 'mailto', 'wa'] as const;
export type DraftHandoffVia = (typeof DRAFT_HANDOFF_VIA)[number];

// ---- row shape (serving.draft) -------------------------------------------------------------

export interface DraftRow {
  id: string;
  account_id: string;
  workspace_id: string;
  entry_id: string;
  kind: DraftKind;
  language: string;
  tone: DraftTone;
  body_generated: string;
  footer: string;
  body_edited: string | null;
  model: string;
  thread_parent: string | null;
  left_via: DraftHandoffVia | null;
  left_at: Date | null;
  created_at: Date;
}

// ---- domain shape ---------------------------------------------------------------------------

export interface Draft {
  id: Id<'draft'>;
  accountId: Id<'account'>;
  workspaceId: Id<'workspace'>;
  entryId: Id<'shortlist_entry'>;
  kind: DraftKind;
  language: string;
  tone: DraftTone;
  bodyGenerated: string;
  footer: string;
  bodyEdited: string | null;
  model: string;
  threadParent: Id<'draft'> | null;
  leftVia: DraftHandoffVia | null;
  leftAt: Date | null;
  createdAt: Date;
}

// ---- wire DTOs --------------------------------------------------------------------------------

/** POST /api/drafts request body. `language` is 'en' or the ISO-639-1 code of the buyer
 * country's primary language (LLD M34 API). */
export interface CreateDraftRequestDto {
  entryId: string;
  language: string;
  tone: DraftTone;
}

export interface PatchDraftRequestDto {
  bodyEdited: string;
}

export interface HandoffRequestDto {
  via: DraftHandoffVia;
}

export interface DraftDto {
  id: string;
  entryId: string;
  kind: DraftKind;
  language: string;
  tone: DraftTone;
  bodyGenerated: string;
  footer: string;
  bodyEdited: string | null;
  model: string;
  leftVia: DraftHandoffVia | null;
  leftAt: string | null;
  createdAt: string;
}

// ---- SSE stream events (LLD M34 API: "SSE stream: data:{delta} … event:footer data:{footer}
// event:done data:{draftId}") ------------------------------------------------------------------

export interface DraftDeltaEvent {
  type: 'delta';
  delta: string;
}

export interface DraftFooterEvent {
  type: 'footer';
  footer: string;
}

export interface DraftDoneEvent {
  type: 'done';
  draftId: string;
}

export type DraftStreamEvent = DraftDeltaEvent | DraftFooterEvent | DraftDoneEvent;
