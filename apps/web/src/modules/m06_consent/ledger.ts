/**
 * M06 — pure ledger logic: validation, folding the append-only history into current state,
 * and deciding which rows a request must append. No I/O here, so it is unit-testable.
 */
import { createHash } from 'node:crypto';
import { AppError, isUuid } from '../m01_platform/index.js';
import type { PayloadSchema } from '../m02_queue/index.js';
import {
  CONSENT_CHANNELS,
  CONSENT_REQUIRED,
  NOTICE_LOCALES,
  PURPOSES,
  type ConsentChannel,
  type ConsentEvent,
  type ConsentWithdrawnPayload,
  type CurrentConsent,
  type NoticeLocale,
  type Purpose,
  type ReacceptStatus,
} from './types.js';

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_NOTICE_BYTES = 256 * 1024;

export function isPurpose(v: unknown): v is Purpose {
  return typeof v === 'string' && (PURPOSES as readonly string[]).includes(v);
}

export function isChannel(v: unknown): v is ConsentChannel {
  return typeof v === 'string' && (CONSENT_CHANNELS as readonly string[]).includes(v);
}

export function isNoticeLocale(v: unknown): v is NoticeLocale {
  return typeof v === 'string' && (NOTICE_LOCALES as readonly string[]).includes(v);
}

export function parsePurpose(v: unknown): Purpose {
  if (!isPurpose(v)) {
    throw new AppError('VALIDATION', 'Unknown consent purpose', { field: 'purpose', allowed: [...PURPOSES] });
  }
  return v;
}

/** Validates and de-duplicates a purpose list, keeping first-seen order. */
export function parsePurposes(v: unknown): Purpose[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new AppError('VALIDATION', 'purposes must be a non-empty array', { field: 'purposes', allowed: [...PURPOSES] });
  }
  const out: Purpose[] = [];
  for (const p of v) {
    const purpose = parsePurpose(p);
    if (!out.includes(purpose)) out.push(purpose);
  }
  return out;
}

export function parseNoticeVersion(v: unknown): string {
  if (typeof v !== 'string' || !VERSION_RE.test(v)) {
    throw new AppError('VALIDATION', 'noticeVersion is malformed', { field: 'noticeVersion' });
  }
  return v;
}

export function parseNoticeBody(v: unknown): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new AppError('VALIDATION', 'Notice body must be non-empty markdown', { field: 'bodyMd' });
  }
  if (Buffer.byteLength(v, 'utf8') > MAX_NOTICE_BYTES) {
    throw new AppError('VALIDATION', `Notice body exceeds ${MAX_NOTICE_BYTES} bytes`, { field: 'bodyMd' });
  }
  return v;
}

export function noticeSha256(bodyMd: string): string {
  return createHash('sha256').update(bodyMd, 'utf8').digest('hex');
}

/** Orders ledger rows oldest → newest; uuidv7 ids break ties within the same timestamp. */
export function compareEvents(a: Pick<ConsentEvent, 'at' | 'id'>, b: Pick<ConsentEvent, 'at' | 'id'>): number {
  const d = a.at.getTime() - b.at.getTime();
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Folds the append-only history into the latest decision per purpose. */
export function foldConsent(events: ReadonlyArray<ConsentEvent>): CurrentConsent {
  const sorted = [...events].sort(compareEvents);
  const out: CurrentConsent = {};
  for (const e of sorted) {
    out[e.purpose] = { granted: e.action === 'grant', at: e.at, noticeVersion: e.noticeVersion };
  }
  return out;
}

export function isGranted(state: CurrentConsent, purpose: Purpose): boolean {
  return state[purpose]?.granted === true;
}

/**
 * Which purposes need a new `grant` row. A purpose already granted against the same notice
 * version is skipped so repeated submissions do not bloat the ledger.
 */
export function purposesToGrant(state: CurrentConsent, purposes: ReadonlyArray<Purpose>, noticeVersion: string): Purpose[] {
  return purposes.filter((p) => {
    const s = state[p];
    return !(s && s.granted && s.noticeVersion === noticeVersion);
  });
}

/** Whether a `withdraw` row is needed (only when the purpose is currently granted). */
export function needsWithdraw(state: CurrentConsent, purpose: Purpose): boolean {
  return isGranted(state, purpose);
}

/**
 * Re-accept interstitial rule: core_service must be granted against the current notice.
 * `currentVersions` lists the current version of every locale, since a user may have
 * accepted the notice in either language.
 */
export function reacceptStatus(state: CurrentConsent, currentVersion: string, currentVersions: ReadonlyArray<string>): ReacceptStatus {
  const core = state.core_service;
  const acceptedVersion = core && core.granted ? core.noticeVersion : null;
  const required = acceptedVersion === null || !currentVersions.includes(acceptedVersion);
  return { required, currentVersion, acceptedVersion };
}

/** 409 CONFLICT with sub-code CONSENT_REQUIRED. */
export function consentRequired(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('CONFLICT', message, { ...details, subCode: CONSENT_REQUIRED });
}

export function isConsentRequired(e: unknown): boolean {
  return e instanceof AppError && e.code === 'CONFLICT' && e.details?.subCode === CONSENT_REQUIRED;
}

/** Runtime schema for EV-11 ConsentWithdrawn (registered with M02 by consent.ts). */
export const consentWithdrawnSchema: PayloadSchema<ConsentWithdrawnPayload> = {
  safeParse(input: unknown) {
    if (input === null || typeof input !== 'object') return { success: false, error: { message: 'payload must be an object' } };
    const o = input as Record<string, unknown>;
    if (o.v !== 1) return { success: false, error: { message: 'v must be 1' } };
    if (typeof o.accountId !== 'string' || !isUuid(o.accountId)) return { success: false, error: { message: 'accountId must be a uuid' } };
    if (!isPurpose(o.purpose)) return { success: false, error: { message: 'purpose is not a known consent purpose' } };
    return { success: true, data: { v: 1, accountId: o.accountId, purpose: o.purpose } };
  },
};

/** Postgres inet accepts IPv4/IPv6 only; anything else is stored as null. */
export function inetOrNull(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const s = ip.replace(/^::ffff:/, '');
  return /^[0-9a-fA-F:.]+$/.test(s) && s.length <= 45 && s !== '0.0.0.0' ? s : null;
}
