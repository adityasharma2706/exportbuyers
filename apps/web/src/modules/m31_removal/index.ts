/**
 * M31 Public removal and correction page — public API. Other modules import ONLY from this file.
 *
 * IF-31a  POST /api/public/removal, GET /api/public/removal/verify (registerRemovalRoutes)
 * Review  `removal.request` (M11 IF-11b) — outcomes approve_removal / approve_correction / reject
 *         (reviewTypes.ts). approve_removal suppresses through M10 IF-10d; approve_correction
 *         writes an assertion through M09 IF-09b `operator_correction`.
 * Jobs    `m31.notify_requester` (requester emails) and `m31.purge_expired_challenges` (daily
 *         housekeeping sweep of `serving.public_removal_challenge`).
 *
 * Call registerRemovalModule() once at boot (web and worker), after M10 and M11 have loaded, and
 * before M02's syncRegistrations().
 */
export type { RemovalConfig } from './config.js';
export { loadRemovalConfigFromEnv, removalConfig, resetRemovalConfigForTesting, setRemovalConfig } from './config.js';

export type {
  IdentityCheck,
  NormalisedIdentifiers,
  RemovalChallengeRow,
  RemovalIdentifiersInput,
  RemovalKind,
  RemovalOutcome,
  RemovalOutcomeData,
  RemovalRequestPayload,
  RequestRemovalRequest,
  RequestRemovalResponseDto,
  VerifyRemovalResponseDto,
} from './types.js';
export { IDENTITY_CHECKS, REMOVAL_KINDS, REMOVAL_OUTCOMES } from './types.js';

export { requestRemoval, verifyRemoval, VERIFY_EMAIL_TEMPLATE } from './service.js';

export { REMOVAL_REQUEST_TYPE, registerRemovalReviewType, resetRemovalReviewTypeForTesting } from './reviewTypes.js';

export { NOTIFY_JOB, enqueueNotify, registerNotifyJob, resetNotifyJobForTesting } from './notify.js';
export type { EnqueueNotifyInput, NotifyPayload } from './notify.js';

export { PURGE_JOB, PURGE_SCHEDULE, registerRemovalModule, resetRemovalModuleForTesting, runPurgeExpiredChallenges } from './jobs.js';

export { registerRemovalRoutes } from './routes.js';
export type { RemovalRouteApp, RemovalRouteReply, RemovalRouteRequest } from './routes.js';
