/**
 * M43 Money-back requests — public API. Other modules import ONLY from this file.
 *
 * IF-43a  POST /api/billing/money-back {reason} -> {reviewItemId, status:'filed'}. Eligible only
 *         for the account's first captured payment, within the tunable `windowDays` of it;
 *         otherwise `FORBIDDEN {reasonKey}` (config.ts / service.ts).
 * Review  `billing.money_back` (M11 IF-11b) — outcomes `approve` (Razorpay refund, immediate
 *         subscription cancel, an M28 `adjustment` removing the remaining granted credits, then
 *         an email) and `reject {reasonKey}` (an email) (reviewType.ts).
 * Jobs    `m43.notify_requester` (requester emails; notify.ts).
 *
 * Call registerMoneyBackModule() once at boot (web and worker), after M11, M28 and M36 have
 * loaded, and before M02's syncRegistrations().
 */
export type { MoneyBackConfig } from './config.js';
export { loadMoneyBackConfigFromEnv, moneyBackConfig, resetMoneyBackConfigForTesting, setMoneyBackConfig } from './config.js';

export type {
  MoneyBackIneligibleReasonKey,
  MoneyBackOutcome,
  MoneyBackOutcomeData,
  MoneyBackPayload,
  PaymentLookupRow,
  RequestMoneyBackRequest,
  RequestMoneyBackResponseDto,
} from './types.js';
export { MONEY_BACK_OUTCOMES } from './types.js';

export { systemCtxFor } from './systemCtx.js';

export type { RazorpayRefundClient, RazorpayRefundEntity } from './razorpayRefund.js';
export { razorpayRefundClient, setRazorpayRefundClientForTesting } from './razorpayRefund.js';

export { requestMoneyBack } from './service.js';

export { MONEY_BACK_TYPE, registerMoneyBackReviewType, resetMoneyBackReviewTypeForTesting } from './reviewType.js';

export { NOTIFY_JOB, enqueueNotify, registerNotifyJob, resetNotifyJobForTesting } from './notify.js';
export type { EnqueueNotifyInput, NotifyPayload } from './notify.js';

export { registerMoneyBackModule, resetMoneyBackModuleForTesting } from './jobs.js';

export { registerMoneyBackRoutes } from './routes.js';
export type { MoneyBackRouteApp, MoneyBackRouteReply, MoneyBackRouteRequest } from './routes.js';
