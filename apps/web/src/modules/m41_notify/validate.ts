/**
 * M41 — pure input validation and normalisation (no I/O). All failures are VALIDATION errors
 * carrying `details.field`, the same convention M33's validate.ts uses.
 */
import { AppError, isUuid } from '../m01_platform/index.js';
import { notifyConfig } from './config.js';

function invalid(field: string, message: string, extra?: Record<string, unknown>): AppError {
  return new AppError('VALIDATION', message, { field, ...(extra ?? {}) });
}

export function objectBody(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new AppError('VALIDATION', 'Request body must be a JSON object');
  return v as Record<string, unknown>;
}

/** Free-form "slug" identifiers: serving.reminder.kind / serving.notification.kind (LLD's
 * literal schema carries no check constraint on either, unlike serving.shortlist_entry.status). */
const SLUG_RE = /^[a-z][a-z0-9_]{0,49}$/;
/** i18n title keys additionally allow dots (e.g. "notify.reminder_due"). */
const TITLE_KEY_RE = /^[a-z][a-z0-9_.]{0,99}$/;

export function parseKind(v: unknown, field = 'kind'): string {
  if (typeof v !== 'string' || !SLUG_RE.test(v)) {
    throw invalid(field, `${field} must be 1..50 lowercase letters, digits or underscores, starting with a letter`);
  }
  return v;
}

export function parseTitleKey(v: unknown, field = 'titleKey'): string {
  if (typeof v !== 'string' || !TITLE_KEY_RE.test(v)) {
    throw invalid(field, `${field} must be 1..100 lowercase letters, digits, underscores or dots, starting with a letter`);
  }
  return v;
}

export function parseParams(v: unknown, field = 'params'): Record<string, unknown> {
  if (v === undefined) return {};
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw invalid(field, `${field} must be an object`);
  return v as Record<string, unknown>;
}

export function parseCompanyIdOptional(v: unknown, field = 'companyId'): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !isUuid(v)) throw invalid(field, `${field} must be a uuid`);
  return v.toLowerCase();
}

export function parseAccountId(v: unknown): string {
  if (typeof v !== 'string' || !isUuid(v)) throw invalid('accountId', 'accountId must be a uuid');
  return v.toLowerCase();
}

export function parseEntryId(v: unknown, field = 'entryId'): string {
  if (typeof v !== 'string' || !isUuid(v)) throw invalid(field, `${field} must be a uuid`);
  return v.toLowerCase();
}

export function parseReminderIdParam(v: unknown): string {
  if (typeof v !== 'string' || !isUuid(v)) throw new AppError('NOT_FOUND', 'Reminder not found');
  return v.toLowerCase();
}

export function parseNotificationIdParam(v: unknown): string {
  if (typeof v !== 'string' || !isUuid(v)) throw new AppError('NOT_FOUND', 'Notification not found');
  return v.toLowerCase();
}

/** ISO-8601 timestamp (createReminder's dueAt / snooze's until). Also accepts a Date, since
 * IF-41a is a lib call other modules (M33, M42) may invoke with a real Date, not a wire string. */
export function parseTimestamp(v: unknown, field: string): Date {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw invalid(field, `${field} is not a valid timestamp`);
    return v;
  }
  if (typeof v !== 'string') throw invalid(field, `${field} must be an ISO-8601 timestamp`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw invalid(field, `${field} is not a valid timestamp`, { value: v });
  return d;
}

export function parseCursorLimit(v: unknown): number {
  if (v === undefined || v === null || v === '') return notifyConfig().notificationListDefaultLimit;
  const n = Number(v);
  const max = notifyConfig().notificationListMaxLimit;
  if (!Number.isInteger(n) || n < 1) throw invalid('limit', 'limit must be a positive integer');
  return Math.min(n, max);
}

export function parseBooleanOptional(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw invalid(field, `${field} must be a boolean`);
  return v;
}
