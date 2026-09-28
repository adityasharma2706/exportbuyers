/**
 * M30 Reports and automatic invalid-contact refunds — public API. Other modules import ONLY from
 * this file.
 *
 * IF-30a  POST /api/reports, DELETE /api/hides/:kind/:id
 * IF-30b  M30 is M10's `userHides` provider (REQ-025): serving.user_hide is this module's table,
 *         and registerReportsModule() registers `hiddenCompanies`/`hiddenAssertions` with M10.
 * EV-13   `report.filed`, emitted every time a report is filed.
 * Jobs    m30.reverify_timeout_sweep (hourly) plus the EV-06 (contact.invalidated /
 *         contact.verified, from py/kp/m25_freshness) subscribers that drive the automatic refund.
 * Review  `report.content` (wrong_product/not_buyer/closed/suspicious) and
 *         `report.refund_exception` (an unconfirmed refund over the monthly cap) — M11 review
 *         types this module registers.
 *
 * Call registerReportsModule() once at boot (web and worker), after M10, M11 and M28 have loaded,
 * and before M02's syncRegistrations().
 */
export type {
  ContactInvalidatedPayload,
  ContactVerifiedPayload,
  CreateReportRequest,
  CreateReportResponseDto,
  HideTargetKind,
  RefundExceptionOutcome,
  RefundExceptionPayload,
  RefundKind,
  RefundStatus,
  ReportContentOutcome,
  ReportContentPayload,
  ReportFiledEvent,
  ReportReason,
  ReportRow,
  ReportState,
  ReverifyTrigger,
  UserHideRow,
} from './types.js';
export { CONTENT_REPORT_REASONS, HIDE_TARGET_KINDS, REPORT_REASONS, REPORT_STATES } from './types.js';

export { loadReportsConfigFromEnv, reportsConfig, resetReportsConfigForTesting, setReportsConfig } from './config.js';
export type { ReportsConfig } from './config.js';

export { EV_CONTACT_INVALIDATED, EV_CONTACT_VERIFIED, EV_REPORT_FILED } from './events.js';

export { createReport, deleteHide } from './service.js';

export { REFUND_EXCEPTION_TYPE, REPORT_CONTENT_TYPE, registerReportReviewTypes, resetReportReviewTypesForTesting } from './reviewTypes.js';

export { settleInvalidContactReport } from './refunds.js';

export {
  SWEEP_JOB,
  SWEEP_SCHEDULE,
  registerReportsModule,
  resetReportsModuleForTesting,
  runReverifyTimeoutSweep,
} from './jobs.js';

export { registerReportsRoutes } from './routes.js';
export type { ReportsRouteApp, ReportsRouteReply, ReportsRouteRequest } from './routes.js';
