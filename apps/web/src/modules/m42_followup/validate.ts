/**
 * M42 — request parsing (LLD M42 API: "the same as M34" request/response shape, minus `entryId`).
 */
import { AppError, isUuid } from '../m01_platform/index.js';
import { DRAFT_TONES, objectBody, type DraftTone } from '../m34_draft/index.js';
import type { CreateFollowUpRequestDto } from './types.js';

/** ISO-639-1 is exactly two lowercase letters (same rule M34's own validate.ts uses). */
const LANGUAGE_RE = /^[a-z]{2}$/;

export function parseParentIdParam(raw: unknown): string {
  if (typeof raw !== 'string' || !isUuid(raw)) throw new AppError('VALIDATION', 'parentId must be a uuid', { field: 'parentId' });
  return raw.toLowerCase();
}

/** POST /api/drafts/:parentId/follow-up {language, tone} (LLD M42 API). */
export function parseCreateFollowUpRequest(raw: unknown): CreateFollowUpRequestDto {
  const b = objectBody(raw);
  if (typeof b.language !== 'string' || !LANGUAGE_RE.test(b.language)) {
    throw new AppError('VALIDATION', 'language must be an ISO-639-1 code (e.g. "en")', { field: 'language' });
  }
  if (typeof b.tone !== 'string' || !(DRAFT_TONES as readonly string[]).includes(b.tone)) {
    throw new AppError('VALIDATION', `tone must be one of ${DRAFT_TONES.join(', ')}`, { field: 'tone' });
  }
  return { language: b.language, tone: b.tone as DraftTone };
}
