/**
 * M34 — request parsing (LLD M34 API).
 */
import { AppError, isUuid } from '../m01_platform/index.js';
import { DRAFT_HANDOFF_VIA, DRAFT_TONES, type CreateDraftRequestDto, type DraftHandoffVia, type DraftTone } from './types.js';

/** ISO-639-1 is exactly two lowercase letters. */
const LANGUAGE_RE = /^[a-z]{2}$/;

const MAX_BODY_EDITED_CHARS = 20_000;

export function objectBody(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('VALIDATION', 'Request body must be an object');
  }
  return raw as Record<string, unknown>;
}

export function parseDraftIdParam(raw: unknown): string {
  if (typeof raw !== 'string' || !isUuid(raw)) throw new AppError('VALIDATION', 'id must be a uuid', { field: 'id' });
  return raw.toLowerCase();
}

/** POST /api/drafts {entryId, language, tone} (LLD M34 API). */
export function parseCreateDraftRequest(raw: unknown): CreateDraftRequestDto {
  const b = objectBody(raw);
  if (typeof b.entryId !== 'string' || !isUuid(b.entryId)) {
    throw new AppError('VALIDATION', 'entryId must be a uuid', { field: 'entryId' });
  }
  if (typeof b.language !== 'string' || !LANGUAGE_RE.test(b.language)) {
    throw new AppError('VALIDATION', 'language must be an ISO-639-1 code (e.g. "en")', { field: 'language' });
  }
  if (typeof b.tone !== 'string' || !(DRAFT_TONES as readonly string[]).includes(b.tone)) {
    throw new AppError('VALIDATION', `tone must be one of ${DRAFT_TONES.join(', ')}`, { field: 'tone' });
  }
  return { entryId: b.entryId.toLowerCase(), language: b.language, tone: b.tone as DraftTone };
}

/** PATCH /api/drafts/:id {bodyEdited} (LLD M34 API). */
export function parsePatchDraftRequest(raw: unknown): { bodyEdited: string } {
  const b = objectBody(raw);
  if (typeof b.bodyEdited !== 'string' || b.bodyEdited.trim().length === 0) {
    throw new AppError('VALIDATION', 'bodyEdited must be a non-empty string', { field: 'bodyEdited' });
  }
  if (b.bodyEdited.length > MAX_BODY_EDITED_CHARS) {
    throw new AppError('VALIDATION', `bodyEdited must be at most ${MAX_BODY_EDITED_CHARS} characters`, { field: 'bodyEdited' });
  }
  return { bodyEdited: b.bodyEdited };
}

/** POST /api/drafts/:id/handoff {via} (LLD M34 IF-34c). */
export function parseHandoffRequest(raw: unknown): { via: DraftHandoffVia } {
  const b = objectBody(raw);
  if (typeof b.via !== 'string' || !(DRAFT_HANDOFF_VIA as readonly string[]).includes(b.via)) {
    throw new AppError('VALIDATION', `via must be one of ${DRAFT_HANDOFF_VIA.join(', ')}`, { field: 'via' });
  }
  return { via: b.via as DraftHandoffVia };
}
