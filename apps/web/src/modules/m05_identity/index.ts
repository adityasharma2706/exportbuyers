/**
 * M05 Identity and sessions — public API. Other modules import ONLY from this file.
 *
 * IF-05a OtpAuth         registerIdentityRoutes(app): OTP request/verify, logout, admin MFA
 * IF-05b resolveSession  resolveSession(req) → ActorContext (creates an anonymous session)
 * IF-05c guardAnonymous  guardAnonymous(ctx, bucket) → throws RATE_LIMITED (maybe challenge)
 * Vendors                sendTransactionalEmail(...), sendSms(...) — wrapped later by M41
 * IF-38a                 exportIdentity(accountId), eraseIdentity(accountId)
 */
export { ANON_BUCKETS, identityConfig, loadIdentityConfig, setIdentityConfig } from './config.js';
export type { AnonBucket, IdentityConfig } from './config.js';

export {
  ANONYMOUS_ENTITLEMENTS,
  FALLBACK_FREE_ENTITLEMENTS,
  applySessionCookies,
  clientIp,
  pendingCookies,
  requestMetaOf,
  requireMember,
  resolveSession,
  setEntitlementsProvider,
} from './session.js';
export type { EntitlementsProvider, HttpReplyLike, HttpRequestLike, RequestMeta } from './session.js';

export { guardAnonymous, setTurnstileVerifier } from './guard.js';
export type { TurnstileVerifier } from './guard.js';

export { requestOtp, verifyOtp, OTP_EMAIL_TEMPLATE } from './otp.js';
export type { OtpRequestResult, OtpVerifyResult } from './otp.js';

export { provisionAdminTotp, requireAdmin, verifyAdminMfa } from './admin.js';

export {
  ConsoleEmailProvider,
  ConsoleSmsProvider,
  SEND_EMAIL_JOB,
  sendSms,
  sendTransactionalEmail,
  setVendorProviders,
} from './vendors.js';
export type { EmailMessage, EmailProvider, SmsProvider } from './vendors.js';

export { registerIdentityJobs, PURGE_JOB } from './jobs.js';
export { registerIdentityRoutes } from './routes.js';
export type { RouteApp, RouteReply, RouteRequest } from './routes.js';

export { takeAnonStatePending, updateAnonState } from './repo.js';
export type { AccountStatus, AdminRole, MemberRole } from './repo.js';

export { eraseIdentity, exportIdentity } from './dataRights.js';
export type { IdentityExport } from './dataRights.js';

export { MemorySlidingWindowStore, setRateStore } from './rateLimit.js';
export type { SlidingWindowStore, WindowResult, WindowSpec } from './rateLimit.js';
