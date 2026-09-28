/**
 * M33 — pure input validation and normalisation (no I/O). All failures are VALIDATION errors
 * carrying `details.field` so the UI can point at the offending input.
 */
import { AppError, isUuid } from '../m01_platform/index.js';
import { pipelineConfig } from './config.js';
import { SHORTLIST_STATUSES, type ShortlistStatus, type UpdateShortlistStatusInput } from './types.js';

function invalid(field: string, message: string, extra?: Record<string, unknown>): AppError {
  return new AppError('VALIDATION', message, { field, ...(extra ?? {}) });
}

export function objectBody(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new AppError('VALIDATION', 'Request body must be a JSON object');
  return v as Record<string, unknown>;
}

/** POST /api/workspaces/:ws/shortlist body: {companyIds: string[] ≤ 200}. De-duplicates, keeps order. */
export function parseCompanyIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) throw invalid('companyIds', 'companyIds must be a non-empty array of uuids');
  const max = pipelineConfig().maxBulkAdd;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string' || !isUuid(item)) throw invalid('companyIds', `"${String(item)}" is not a valid company id`, { value: item });
    const id = item.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > max) throw invalid('companyIds', `At most ${max} companies can be added at once`, { max, count: out.length });
  return out;
}

export function isShortlistStatus(v: unknown): v is ShortlistStatus {
  return typeof v === 'string' && (SHORTLIST_STATUSES as readonly string[]).includes(v);
}

export function parseShortlistStatus(v: unknown, field = 'status'): ShortlistStatus {
  if (!isShortlistStatus(v)) {
    throw invalid(field, `${field} must be one of ${SHORTLIST_STATUSES.join(', ')}`, { allowed: [...SHORTLIST_STATUSES] });
  }
  return v;
}

/** ISO-8601 timestamp, or null to clear the reminder. */
export function parseNextActionAt(v: unknown, field = 'nextActionAt'): Date | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw invalid(field, `${field} must be an ISO-8601 timestamp or null`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw invalid(field, `${field} is not a valid timestamp`, { value: v });
  return d;
}

/** PATCH /api/shortlist/:id body: {status?, nextActionAt?}. At least one field must be present. */
export function parseStatusPatch(body: unknown): UpdateShortlistStatusInput {
  const b = objectBody(body);
  for (const k of Object.keys(b)) {
    if (k !== 'status' && k !== 'nextActionAt') throw invalid(k, `Unknown field ${k}`);
  }
  const out: UpdateShortlistStatusInput = {};
  if ('status' in b) out.status = parseShortlistStatus(b.status);
  if ('nextActionAt' in b) out.nextActionAt = b.nextActionAt === null ? null : (parseNextActionAt(b.nextActionAt).toISOString());
  if (Object.keys(out).length === 0) throw new AppError('VALIDATION', 'Nothing to update');
  return out;
}

/** POST/PATCH /api/shortlist/:id/notes body: {body}, PATCH/DELETE also need {noteId}. */
export function parseNoteBody(v: unknown): string {
  if (typeof v !== 'string') throw invalid('body', 'Note body is required');
  const s = v.normalize('NFC').trim();
  if (s.length === 0) throw invalid('body', 'Note body is required');
  const max = pipelineConfig().noteMaxLength;
  if (s.length > max) throw invalid('body', `Note must be at most ${max} characters`, { max });
  return s;
}

export function parseNoteId(v: unknown): string {
  if (typeof v !== 'string' || !isUuid(v)) throw invalid('noteId', 'noteId must be a uuid');
  return v.toLowerCase();
}

export function parseWorkspaceIdParam(v: unknown): string {
  if (typeof v !== 'string' || !isUuid(v)) throw new AppError('NOT_FOUND', 'Workspace not found');
  return v.toLowerCase();
}

export function parseEntryIdParam(v: unknown): string {
  if (typeof v !== 'string' || !isUuid(v)) throw new AppError('NOT_FOUND', 'Shortlist entry not found');
  return v.toLowerCase();
}

/** Optional `?status=` query filter. */
export function parseStatusQuery(v: unknown): ShortlistStatus | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return parseShortlistStatus(v, 'status');
}

export function parseWorkspaceIdQuery(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !isUuid(v)) throw invalid('workspaceId', 'workspaceId must be a uuid');
  return v.toLowerCase();
}
