/**
 * M30 — the two M11 (IF-11b) review types this module owns.
 *
 *   report.content         wrong_product / not_buyer / closed / suspicious reports (LLD M30
 *                           Rules: "file report.content, deduped per (company, reason) ...
 *                           apply -> IF-09b (report_not_buyer {hs_heading} or report_closed);
 *                           dismiss"). Which of the two IF-09b commands `apply` sends is derived
 *                           from the stored `reason` (`closed` -> report_closed, everything else
 *                           -> report_not_buyer), so the outcome itself needs no extra admin input.
 *   report.refund_exception  an invalid_contact report whose unconfirmed refund would put the
 *                             account over `refunds_unconfirmed_per_month` (LLD M30 Rules: "Over
 *                             the cap -> file report.refund_exception"). `admin_super` only (LLD
 *                             M11 RBAC: "admin_super has everything, including refunds above the
 *                             cap").
 *
 * Call registerReportReviewTypes() once at boot (web and worker), before M02's
 * syncRegistrations(), same as every other registerType() caller.
 */
import { z } from 'zod';
import { AppError } from '../m01_platform/index.js';
import { DEFAULT_SLA_HOURS, registerType, sendAssertionCommand, type AssertionCommandKind, type ReviewItem } from '../m11_review/index.js';
import type { Tx } from '../m02_queue/index.js';
import { refund } from '../m28_credits/index.js';
import { closeReportsForReviewItem, setReportRefunded, setReportState } from './repo.js';
import { SYSTEM_CTX } from './systemCtx.js';
import { CONTENT_REPORT_REASONS, type RefundExceptionPayload, type ReportContentPayload, type ReportReason } from './types.js';

export const REPORT_CONTENT_TYPE = 'report.content';
export const REFUND_EXCEPTION_TYPE = 'report.refund_exception';

const reportContentPayloadSchema: z.ZodType<ReportContentPayload, z.ZodTypeDef, unknown> = z.object({
  companyId: z.string().uuid(),
  reason: z.enum(CONTENT_REPORT_REASONS as [ReportReason, ...ReportReason[]]),
  hsHeading: z.string().max(300).nullable(),
  count: z.number().int().min(1),
});

const refundExceptionPayloadSchema: z.ZodType<RefundExceptionPayload, z.ZodTypeDef, unknown> = z.object({
  reportId: z.string().uuid(),
  accountId: z.string().uuid(),
  companyId: z.string().uuid(),
  assertionId: z.string().uuid(),
  revealId: z.string().uuid(),
  commitEntryId: z.string().uuid(),
  credits: z.number().int().min(1),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  exceptionReason: z.literal('monthly_cap_exceeded'),
});

/** Neither outcome needs admin-supplied data (LLD M30 Rules gives no `data` shape for either
 * type); IF-11b still requires an outcomeSchema, so this accepts (and ignores) whatever is sent. */
const emptyOutcomeSchema = z.object({}).passthrough();

async function onReportContentOutcome(
  item: ReviewItem<ReportContentPayload>,
  outcome: string,
  _data: unknown,
  tx: Tx,
): Promise<void> {
  if (outcome === 'apply') {
    const command: AssertionCommandKind = item.payload.reason === 'closed' ? 'report_closed' : 'report_not_buyer';
    const cmdPayload = command === 'report_not_buyer' ? { hs_heading: item.payload.hsHeading } : {};
    await sendAssertionCommand(tx, item, { kind: command, subjectId: item.payload.companyId, payload: cmdPayload });
  } else if (outcome !== 'dismiss') {
    throw new AppError('INTERNAL', `report.content: unexpected outcome "${outcome}"`);
  }
  await closeReportsForReviewItem(tx, item.id);
}

async function onRefundExceptionOutcome(
  item: ReviewItem<RefundExceptionPayload>,
  outcome: string,
  _data: unknown,
  tx: Tx,
): Promise<void> {
  if (outcome === 'approve') {
    const result = await refund(SYSTEM_CTX, {
      refersTo: item.payload.commitEntryId,
      credits: item.payload.credits,
      reason: 'invalid_contact report: admin-approved refund over the monthly unconfirmed-refund cap',
      idempotencyKey: `refund:${item.payload.revealId}:${item.payload.assertionId}`,
    });
    await setReportRefunded(tx, item.payload.reportId, {
      refundKind: 'unconfirmed',
      refundPeriod: item.payload.period,
      refundCredits: result.refunded,
      refundEntryId: result.refundEntryId,
    });
  } else if (outcome === 'deny') {
    await setReportState(tx, item.payload.reportId, 'closed');
  } else {
    throw new AppError('INTERNAL', `report.refund_exception: unexpected outcome "${outcome}"`);
  }
}

let registered = false;

export function registerReportReviewTypes(): void {
  if (registered) return;

  registerType<ReportContentPayload, Record<string, unknown>>({
    type: REPORT_CONTENT_TYPE,
    payloadSchema: reportContentPayloadSchema,
    outcomes: ['apply', 'dismiss'],
    outcomeSchema: emptyOutcomeSchema,
    slaHours: DEFAULT_SLA_HOURS.report,
    view: {
      titleKey: 'm30.review.reportContent.title',
      fields: [
        { path: 'companyId', labelKey: 'm30.review.reportContent.companyId' },
        { path: 'reason', labelKey: 'm30.review.reportContent.reason' },
        { path: 'hsHeading', labelKey: 'm30.review.reportContent.hsHeading' },
        { path: 'count', labelKey: 'm30.review.reportContent.count' },
      ],
      outcomeLabelKeys: { apply: 'm30.review.reportContent.apply', dismiss: 'm30.review.reportContent.dismiss' },
      confirmOutcomes: ['apply'],
    },
    onOutcome: onReportContentOutcome,
    requiredRole: 'admin_support',
    rejectingOutcomes: ['dismiss'],
  });

  registerType<RefundExceptionPayload, Record<string, unknown>>({
    type: REFUND_EXCEPTION_TYPE,
    payloadSchema: refundExceptionPayloadSchema,
    outcomes: ['approve', 'deny'],
    outcomeSchema: emptyOutcomeSchema,
    slaHours: DEFAULT_SLA_HOURS.moneyBack,
    view: {
      titleKey: 'm30.review.refundException.title',
      fields: [
        { path: 'accountId', labelKey: 'm30.review.refundException.accountId' },
        { path: 'companyId', labelKey: 'm30.review.refundException.companyId' },
        { path: 'assertionId', labelKey: 'm30.review.refundException.assertionId' },
        { path: 'credits', labelKey: 'm30.review.refundException.credits' },
        { path: 'period', labelKey: 'm30.review.refundException.period' },
      ],
      outcomeLabelKeys: { approve: 'm30.review.refundException.approve', deny: 'm30.review.refundException.deny' },
      confirmOutcomes: ['approve', 'deny'],
    },
    onOutcome: onRefundExceptionOutcome,
    requiredRole: 'admin_super',
    rejectingOutcomes: ['deny'],
  });

  registered = true;
}

/** Test hook. */
export function resetReportReviewTypesForTesting(): void {
  registered = false;
}
