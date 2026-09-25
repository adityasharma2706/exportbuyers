/**
 * M06 — shared types for privacy notices and the consent ledger.
 */
import type { Id } from '../m01_platform/index.js';

export const PURPOSES = ['core_service', 'marketing_email', 'whatsapp', 'analytics'] as const;
export type Purpose = (typeof PURPOSES)[number];

export const CONSENT_ACTIONS = ['grant', 'withdraw'] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];

export const CONSENT_CHANNELS = ['web', 'api', 'admin', 'whatsapp', 'email'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export const NOTICE_LOCALES = ['en', 'hi'] as const;
export type NoticeLocale = (typeof NOTICE_LOCALES)[number];

/** Sub-code carried in `details.subCode` of a 409 CONFLICT when consent is missing or stale. */
export const CONSENT_REQUIRED = 'CONSENT_REQUIRED' as const;

/** EV-11 ConsentWithdrawn — outbox event type written by withdrawConsent(). */
export const CONSENT_WITHDRAWN_EVENT = 'consent.withdrawn' as const;

export interface ConsentWithdrawnPayload {
  v: 1;
  accountId: string;
  purpose: Purpose;
}

// Type-only augmentation so emit()/subscribe() on 'consent.withdrawn' are payload-typed.
// TypeScript merges augmentations into the declaring file, hence the direct path.
declare module '../m02_queue/types.js' {
  interface EventRegistry {
    'consent.withdrawn': ConsentWithdrawnPayload;
  }
}

export interface PrivacyNotice {
  version: string;
  locale: NoticeLocale;
  bodyMd: string;
  publishedAt: Date;
  sha256: string;
}

/** One row of serving.consent_event. */
export interface ConsentEvent {
  id: Id<'consent_event'>;
  accountId: Id<'account'>;
  memberId: Id<'member'> | null;
  purpose: Purpose;
  action: ConsentAction;
  noticeVersion: string;
  channel: ConsentChannel;
  ip: string | null;
  at: Date;
}

export interface ConsentStatus {
  granted: boolean;
  at: Date;
  noticeVersion: string;
}

/**
 * Current state per purpose. A purpose with no ledger entry is absent (never asked); treat it
 * as not granted. Use isGranted() rather than indexing directly.
 */
export type CurrentConsent = Partial<Record<Purpose, ConsentStatus>>;

/** Payload passed to the Consent Manager hook after the ledger write commits. */
export interface ConsentHookEvent {
  eventId: string;
  accountId: string;
  memberId: string | null;
  purpose: Purpose;
  action: ConsentAction;
  noticeVersion: string;
  channel: ConsentChannel;
  at: Date;
}

/**
 * Reserved for a future DPDP-registered Consent Manager. Both callbacks are optional and are
 * invoked after commit; a failure is logged and never undoes the ledger write.
 */
export interface ConsentManagerHook {
  onGrant?(e: ConsentHookEvent): void | Promise<void>;
  onWithdraw?(e: ConsentHookEvent): void | Promise<void>;
}

export interface RecordConsentOptions {
  /** Where the consent was captured. Defaults to 'web'. */
  channel?: ConsentChannel;
  /** Client IP. Defaults to the IP of the request that produced ctx, when known. */
  ip?: string | null;
}

export interface ReacceptStatus {
  /** True when the account has not granted core_service against the current notice. */
  required: boolean;
  currentVersion: string;
  acceptedVersion: string | null;
}
