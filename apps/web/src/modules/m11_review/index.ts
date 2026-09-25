/**
 * M11 Review queue and admin console (core) — public API. Other modules import ONLY from this file.
 *
 * IF-11a file(tx, type, {subjectRefs, payload, filedBy, dedupeKey?}) → Id<'review_item'>
 * IF-11b registerType({type, payloadSchema, outcomes, outcomeSchema, slaHours, view, onOutcome,
 *        requiredRole?, rejectingOutcomes?})
 * EV-07  `review.outcome.<itemType>` {v, itemId, itemType, outcome} — emitted by resolve; the
 *        registered onOutcome runs as its handler.
 * Admin  registerReviewRoutes(app): GET /admin/review, GET /admin/review/:id,
 *        POST /admin/review/:id/{claim,release,resolve}
 * Write-back helpers for outcome handlers: sendAssertionCommand (M09 IF-09b),
 *        suppressFromReview (M10 IF-10d).
 *
 * Call registerReviewModule() at boot (web and worker) before M02's syncRegistrations().
 */
export type {
  ConsoleViewField,
  ConsoleViewSpec,
  FileInput,
  FiledBy,
  FiledByKind,
  HandlerResult,
  OutcomeHandler,
  ReviewAlertSink,
  ReviewAuditAction,
  ReviewAuditEntry,
  ReviewItem,
  ReviewOutcomeEvent,
  ReviewState,
  ReviewTypeDef,
  SlaBreachSummary,
  SubjectRef,
} from './types.js';
export { ACTIVE_STATES, FILED_BY_KINDS, REVIEW_STATES } from './types.js';
export {
  DEFAULT_SLA_HOURS,
  configureReviewSla,
  loadReviewSlaFromEnv,
  registeredTypes,
  resetReviewRegistryForTesting,
  roleMayHandle,
  slaHoursFor,
  typesVisibleTo,
} from './registry.js';
export {
  EV_REVIEW_OUTCOME_PREFIX,
  OUTCOME_HANDLER_NAME,
  claimItem,
  file,
  getItem,
  listItems,
  registerType,
  releaseItem,
  resolveItem,
  reviewOutcomeEventType,
} from './service.js';
export type { ListResult, ReviewTypeInfo } from './service.js';
export {
  DEAD_LETTER_TYPE,
  SLA_BREACH_JOB,
  SLA_BREACH_SCHEDULE,
  deadLetterPayloadSchema,
  registerReviewModule,
  resetReviewModuleForTesting,
  runSlaBreachCheck,
  setReviewAlertSink,
} from './jobs.js';
export type { DeadLetterOutcome, DeadLetterPayload } from './jobs.js';
export {
  ASSERTION_COMMAND_JOB,
  ASSERTION_COMMAND_KINDS,
  reviewActor,
  sendAssertionCommand,
  suppressFromReview,
} from './writeback.js';
export type { AssertionCommandInput, AssertionCommandKind } from './writeback.js';
export { registerReviewRoutes } from './routes.js';
export type { ReviewRouteApp, ReviewRouteRequest } from './routes.js';
