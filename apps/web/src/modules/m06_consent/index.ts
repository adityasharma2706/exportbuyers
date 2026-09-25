/**
 * M06 Consent and privacy notice ledger — public API. Other modules import ONLY from this file.
 *
 * IF-06a  recordConsent(ctx, purposes, noticeVersion), withdrawConsent(ctx, purpose),
 *         currentConsent(accountId), consentManagerHook
 * Gates   assertCoreConsent(ctx) → 409 CONFLICT subCode CONSENT_REQUIRED; reacceptStatus(...)
 * EV-11   'consent.withdrawn' {v:1, accountId, purpose} — emitted in the ledger transaction
 * IF-38a  exportConsent(accountId), eraseConsent(accountId)
 */
export {
  CONSENT_ACTIONS,
  CONSENT_CHANNELS,
  CONSENT_REQUIRED,
  CONSENT_WITHDRAWN_EVENT,
  NOTICE_LOCALES,
  PURPOSES,
} from './types.js';
export type {
  ConsentAction,
  ConsentChannel,
  ConsentEvent,
  ConsentHookEvent,
  ConsentManagerHook,
  ConsentStatus,
  ConsentWithdrawnPayload,
  CurrentConsent,
  NoticeLocale,
  PrivacyNotice,
  Purpose,
  ReacceptStatus,
  RecordConsentOptions,
} from './types.js';

export {
  assertCoreConsent,
  consentHistory,
  consentManagerHook,
  consentWithdrawnSchema,
  currentConsent,
  currentNotice,
  getPrivacyNotice,
  hasConsent,
  listPrivacyNotices,
  publishNotice,
  reacceptStatus,
  recordConsent,
  setConsentManagerHook,
  withdrawConsent,
} from './consent.js';
export type { PublishNoticeInput } from './consent.js';

export { foldConsent, isConsentRequired, isGranted, isPurpose, noticeSha256 } from './ledger.js';

export type { ConsentEventRow } from './repo.js';

export { eraseConsent, exportConsent } from './dataRights.js';
export type { ConsentExport } from './dataRights.js';

export { registerConsentRoutes } from './routes.js';
export type { ConsentRouteApp, ConsentRouteReply, ConsentRouteRequest } from './routes.js';
