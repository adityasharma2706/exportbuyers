/**
 * M42 — shared types (LLD M42 "Follow-up drafts"). REQ-041.
 *
 * Follow-up drafts reuse M34's `serving.draft` table verbatim (same migration, same `kind` check
 * constraint: `'first' | 'follow_up_1' | 'follow_up_2' | 'whatsapp_intro'` — see
 * db/migrations/0034_m34_draft.sql's own doc comment, which already reserves the two kinds below
 * for "a later follow-up-drafting module that reuses this same table without a new migration").
 * This module only ever writes the two follow-up kinds.
 */
import type { DraftTone } from '../m34_draft/index.js';

export const FOLLOW_UP_KINDS = ['follow_up_1', 'follow_up_2'] as const;
export type FollowUpDraftKind = (typeof FOLLOW_UP_KINDS)[number];

/** POST /api/drafts/:parentId/follow-up request body (LLD M42: "the same as M34"; `entryId` is
 * not carried here — it comes from the parent draft named by `:parentId`). */
export interface CreateFollowUpRequestDto {
  language: string;
  tone: DraftTone;
}
