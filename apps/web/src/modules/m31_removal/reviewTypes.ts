/**
 * M31 — the M11 (IF-11b) review type this module owns: `removal.request`.
 *
 *   approve_removal    -> M10 `suppress(identifiers + matched company id, 'removal_request',
 *                          itemId)`, then an email to the requester (`removal.confirmed`)
 *                          (LLD M31 Outcomes).
 *   approve_correction {attribute, value} -> IF-09b `operator_correction` against the matched
 *                          company (LLD M31 Outcomes).
 *   reject {reasonKey} -> an email to the requester (LLD M31 Outcomes).
 *
 * Call registerRemovalReviewType() once at boot (web and worker), before M02's
 * syncRegistrations(). registerRemovalModule() (jobs.ts) does this.
 */
import { z } from 'zod';
import { NonRetryable, type Tx } from '../m02_queue/index.js';
import type { SuppressionEntry } from '../m10_policy/index.js';
import { DEFAULT_SLA_HOURS, registerType, sendAssertionCommand, suppressFromReview, type ReviewItem } from '../m11_review/index.js';
import { enqueueNotify } from './notify.js';
import {
  IDENTITY_CHECKS,
  REMOVAL_KINDS,
  type IdentityCheck,
  type NormalisedIdentifiers,
  type RemovalKind,
  type RemovalOutcomeData,
  type RemovalRequestPayload,
} from './types.js';

export const REMOVAL_REQUEST_TYPE = 'removal.request';

const identifiersPayloadSchema = z.object({
  domain: z.string().max(255).optional(),
  email: z.string().max(320).optional(),
  phone: z.string().max(64).optional(),
  companyName: z.string().max(300).optional(),
  country: z.string().max(100).optional(),
});

const removalRequestPayloadSchema: z.ZodType<RemovalRequestPayload, z.ZodTypeDef, unknown> = z.object({
  kind: z.enum(REMOVAL_KINDS as [RemovalKind, ...RemovalKind[]]),
  requesterEmail: z.string().email().max(320),
  identifiers: identifiersPayloadSchema,
  matchedCompanyId: z.string().uuid().nullable(),
  details: z.string().max(2000).nullable(),
  identityCheck: z.enum(IDENTITY_CHECKS as [IdentityCheck, ...IdentityCheck[]]),
});

/**
 * Shared across all three outcomes (IF-11b has one outcomeSchema per type, not per outcome — the
 * same pattern M17's `sanctions.possible_match` and M30's `report.refund_exception` use). Which
 * fields are actually required depends on the chosen outcome; `onOutcome` below enforces that.
 */
const removalOutcomeSchema: z.ZodType<RemovalOutcomeData, z.ZodTypeDef, unknown> = z.object({
  attribute: z.string().min(1).max(200).optional(),
  value: z.record(z.unknown()).optional(),
  reasonKey: z.string().min(1).max(100).optional(),
});

function buildSuppressionEntries(ids: NormalisedIdentifiers, matchedCompanyId: string | null): SuppressionEntry[] {
  const entries: SuppressionEntry[] = [];
  if (ids.domain) entries.push({ kind: 'domain', raw: ids.domain });
  if (ids.email) entries.push({ kind: 'email', raw: ids.email });
  if (ids.phone) entries.push({ kind: 'phone', raw: ids.phone });
  if (matchedCompanyId) entries.push({ kind: 'company_id', raw: matchedCompanyId });
  return entries;
}

async function onRemovalOutcome(
  item: ReviewItem<RemovalRequestPayload>,
  outcome: string,
  data: RemovalOutcomeData,
  tx: Tx,
): Promise<void> {
  if (outcome === 'approve_removal') {
    const entries = buildSuppressionEntries(item.payload.identifiers, item.payload.matchedCompanyId);
    if (entries.length === 0) {
      // Nothing hashable was ever supplied (e.g. a companyName/country-only submission with no
      // catalogue match). LLD M31 always suppresses on approve_removal; there is nothing to
      // suppress here, so this needs an operator decision the console cannot make for them.
      throw new NonRetryable('removal.request: no suppressible identifiers (domain/email/phone/matched company) on this item');
    }
    await suppressFromReview(tx, item, entries, 'removal_request');
    await enqueueNotify(tx, {
      to: item.payload.requesterEmail,
      templateKey: 'removal.confirmed',
      params: { kind: item.payload.kind },
      idempotencyKey: `${item.id}:approve_removal`,
    });
    return;
  }

  if (outcome === 'approve_correction') {
    if (!data.attribute || !data.value || typeof data.value !== 'object' || Array.isArray(data.value)) {
      throw new NonRetryable('removal.request: approve_correction needs data.attribute and an object data.value');
    }
    if (!item.payload.matchedCompanyId) {
      throw new NonRetryable('removal.request: approve_correction needs a matched company; none was found for this item');
    }
    await sendAssertionCommand(tx, item, {
      kind: 'operator_correction',
      subjectId: item.payload.matchedCompanyId,
      payload: { attribute: data.attribute, value: data.value },
    });
    return;
  }

  if (outcome === 'reject') {
    if (!data.reasonKey) throw new NonRetryable('removal.request: reject needs data.reasonKey');
    await enqueueNotify(tx, {
      to: item.payload.requesterEmail,
      templateKey: 'removal.rejected',
      params: { kind: item.payload.kind, reasonKey: data.reasonKey },
      idempotencyKey: `${item.id}:reject`,
    });
    return;
  }

  throw new NonRetryable(`removal.request: unexpected outcome "${outcome}"`);
}

let registered = false;

/** Registers the `removal.request` review type. Idempotent. */
export function registerRemovalReviewType(): void {
  if (registered) return;
  registerType<RemovalRequestPayload, RemovalOutcomeData>({
    type: REMOVAL_REQUEST_TYPE,
    payloadSchema: removalRequestPayloadSchema,
    outcomes: ['approve_removal', 'approve_correction', 'reject'],
    outcomeSchema: removalOutcomeSchema,
    slaHours: DEFAULT_SLA_HOURS.removal,
    requiredRole: 'admin_support',
    view: {
      titleKey: 'm31.review.removal.title',
      fields: [
        { path: 'kind', labelKey: 'm31.review.removal.kind' },
        { path: 'requesterEmail', labelKey: 'm31.review.removal.requesterEmail', format: 'email' },
        { path: 'identifiers', labelKey: 'm31.review.removal.identifiers', format: 'json' },
        { path: 'matchedCompanyId', labelKey: 'm31.review.removal.matchedCompanyId' },
        { path: 'identityCheck', labelKey: 'm31.review.removal.identityCheck' },
        { path: 'details', labelKey: 'm31.review.removal.details' },
      ],
      outcomeLabelKeys: {
        approve_removal: 'm31.review.removal.approveRemoval',
        approve_correction: 'm31.review.removal.approveCorrection',
        reject: 'm31.review.removal.reject',
      },
      confirmOutcomes: ['approve_removal', 'approve_correction', 'reject'],
    },
    onOutcome: onRemovalOutcome,
    rejectingOutcomes: ['reject'],
  });
  registered = true;
}

/** Test hook. */
export function resetRemovalReviewTypeForTesting(): void {
  registered = false;
}
