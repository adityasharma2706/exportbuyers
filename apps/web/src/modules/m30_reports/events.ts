/**
 * M30 — event names and (TS-side) schemas.
 *
 *   EV-13 report.filed         emitted by M30 itself, every time a report is filed (LLD M30
 *                               Rules: "The report also emits EV-13.").
 *   EV-06 contact.invalidated / contact.verified   emitted by M25 (py/kp/m25_freshness/models.py,
 *                               "Writes"); M30 subscribes so an invalid_contact report's
 *                               correlated reveal gets refunded (LLD M30 Rules). The event names
 *                               and JSON shapes here mirror models.py's `ContactInvalidatedEvent`
 *                               / `ContactVerifiedEvent` exactly (camelCase field names — see
 *                               pipeline.py's `repo.emit(...)` calls, which pass plain dicts with
 *                               those keys); M02's outbox is the same Postgres table for both
 *                               languages, so no bridging is needed.
 */
import { z } from 'zod';
import { REPORT_REASONS, type ReportReason } from './types.js';

export const EV_REPORT_FILED = 'report.filed';
export const EV_CONTACT_INVALIDATED = 'contact.invalidated';
export const EV_CONTACT_VERIFIED = 'contact.verified';

export const reportFiledSchema = z.object({
  v: z.literal(1),
  reportId: z.string().uuid(),
  accountId: z.string().uuid(),
  companyId: z.string().uuid(),
  assertionId: z.string().uuid().nullable(),
  reason: z.enum(REPORT_REASONS as [ReportReason, ...ReportReason[]]),
});

const reverifyTriggerSchema = z.enum(['reveal', 'report', 'schedule']);

export const contactInvalidatedSchema = z
  .object({
    assertionId: z.string().uuid(),
    companyId: z.string().uuid(),
    kind: z.string(),
    trigger: reverifyTriggerSchema,
    triggerRef: z.string(),
  })
  .passthrough();

export const contactVerifiedSchema = z
  .object({
    assertionId: z.string().uuid(),
    companyId: z.string().uuid(),
    kind: z.string(),
    status: z.enum(['valid', 'risky']),
    trigger: reverifyTriggerSchema,
    triggerRef: z.string(),
  })
  .passthrough();
