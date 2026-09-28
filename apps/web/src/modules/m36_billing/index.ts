/**
 * M36 Plans, subscriptions and billing (Razorpay) — public API. Other modules import ONLY from
 * this file.
 *
 * Plan catalogue   getPlansCatalogue(), entitlementsForPlan(), freeEntitlements() (REQ-051)
 * IF-36c           registerBillingEntitlementsProvider() — wires M36 into M10's and M05's
 *                  entitlements providers ("the plan entitlements when the subscription is
 *                  active, otherwise Free", 60 s cache, invalidated by EV-10)
 * Routes           registerBillingRoutes(app): GET /api/plans; POST /api/billing/checkout;
 *                  POST /api/billing/cancel; POST /api/billing/update-method;
 *                  PUT|GET /api/billing/details; GET /api/invoices; GET /api/invoices/:id/pdf;
 *                  POST /webhooks/razorpay
 * Jobs             registerBillingJobs(): m36.process_webhook (webhook heavy-lifting: grants via
 *                  M28, invoices), m36.reconcile (daily Razorpay reconciliation)
 *
 * Call registerBillingEntitlementsProvider() and registerBillingJobs() once at boot, after M02,
 * M05, M10 and M28 are initialised and before serving traffic or starting the queue runtime.
 */
export { billingConfig, loadBillingConfig, setBillingConfig, SECRET_RAZORPAY_KEY_ID, SECRET_RAZORPAY_KEY_SECRET, SECRET_RAZORPAY_WEBHOOK_SECRET } from './config.js';
export type { BillingConfig } from './config.js';

export {
  entitlementsForPlan,
  freeEntitlements,
  getPlansCatalogue,
  isCycle,
  isPlanKey,
  monthlyCreditsFor,
  planDefinition,
  plansDto,
  parsePlansDocument,
  razorpayPlanId,
  setPlansCatalogueForTesting,
  CYCLES,
  PLAN_KEYS,
} from './plans.js';

export { entitlementsForAccount, invalidateEntitlementsCache, registerBillingEntitlementsProvider } from './entitlements.js';

export {
  billingDetailsDto,
  cancelSubscription,
  checkout,
  getMyBillingDetails,
  parseBillingDetails,
  requestPaymentMethodUpdate,
  updateBillingDetails,
} from './subscriptions.js';
export type { BillingDetailsInput, CancelInput, CheckoutInput, CheckoutResult, UpdateMethodResult } from './subscriptions.js';

export { getInvoicePdf, invoiceDto, listInvoices } from './invoices.js';

export { financialYearLabel, invoiceNumber, splitTax } from './gst.js';
export type { TaxSplit } from './gst.js';

export { razorpay, setRazorpayClientForTesting, verifyRazorpayWebhookSignature } from './razorpay.js';
export type { CreateSubscriptionParams, RazorpayClient, RazorpaySubscriptionEntity } from './razorpay.js';

export { handleRazorpayWebhook } from './webhooks.js';
export type { WebhookResult } from './webhooks.js';

export { PROCESS_WEBHOOK_JOB, RECONCILE_JOB, processWebhookEvent, reconcileSubscriptions, registerBillingJobs } from './jobs.js';

export { registerBillingRoutes } from './routes.js';
export type { BillingRouteApp, BillingRouteReply, BillingRouteRequest } from './routes.js';

export type {
  BillingDetailsRow,
  Cycle,
  InvoiceRow,
  PaymentRow,
  PaymentStatus,
  PlanDefinition,
  PlanEntitlements,
  PlanKey,
  PlansCatalogue,
  SubscriptionRow,
  SubscriptionStatus,
} from './types.js';
