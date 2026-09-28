/**
 * M30 — core service (IF-30a).
 *
 *   POST /api/reports {companyId, assertionId?, reason, note?}
 *     -> {reportId, hidden: true, refundStatus?: 'pending'|'not_applicable'}
 *   DELETE /api/hides/:kind/:id -> 204
 *
 * Deps: M10 (byIds, to check the company exists/is visible and to read its primary HS heading;
 * this module also *becomes* M10's `userHides` provider, wired in jobs.ts), M11 (file, for content
 * reports and the over-cap refund exception), M25 (the reverify RPC, via M29's client — kicks off
 * re-verification right away instead of waiting for the 90-day staleness cycle), M28 (istPeriod;
 * the refund itself happens asynchronously off EV-06, see refunds.ts), M29 (reverify()).
 */
import { z } from 'zod';
import { AppError, log, newId, rateLimited, scoped, systemDb, withSpan, type ActorContext, type Id } from '../m01_platform/index.js';
import { requireMember } from '../m05_identity/index.js';
import { byIds, type ProfileDoc } from '../m10_policy/index.js';
import { emit, type Tx } from '../m02_queue/index.js';
import { file } from '../m11_review/index.js';
import { reverify } from '../m29_reveal/index.js';
import { reportsConfig } from './config.js';
import { EV_REPORT_FILED } from './events.js';
import {
  bumpReviewItemCount,
  countReportsForCompanyReason,
  countReportsSince,
  deleteUserHide,
  findRevealForContact,
  insertReport,
  insertUserHide,
  setReportReviewItemIdTx,
} from './repo.js';
import { REPORT_CONTENT_TYPE } from './reviewTypes.js';
import {
  CONTENT_REPORT_REASONS,
  HIDE_TARGET_KINDS,
  REPORT_REASONS,
  type CreateReportResponseDto,
  type HideTargetKind,
  type ReportContentPayload,
  type ReportReason,
  type ReportState,
} from './types.js';

const createReportSchema = z.object({
  companyId: z.string().uuid(),
  assertionId: z.string().uuid().optional(),
  reason: z.enum(REPORT_REASONS as [ReportReason, ...ReportReason[]]),
  note: z.string().max(1000).optional(),
});

function parseCreateReportRequest(raw: unknown): z.infer<typeof createReportSchema> {
  const parsed = createReportSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION', 'Invalid report request', { issues: parsed.error.message });
  return parsed.data;
}

function isContentReason(reason: ReportReason): boolean {
  return (CONTENT_REPORT_REASONS as readonly string[]).includes(reason);
}

function primaryHsHeading(doc: ProfileDoc | null): string | null {
  return doc && Array.isArray(doc.hs_headings) && doc.hs_headings.length > 0 ? doc.hs_headings[0]! : null;
}

/** IF-30a `POST /api/reports`. */
export async function createReport(ctx: ActorContext, rawBody: unknown): Promise<CreateReportResponseDto> {
  const { accountId } = requireMember(ctx);
  const body = parseCreateReportRequest(rawBody);

  return withSpan(
    'm30.createReport',
    async () => {
      const cfg = reportsConfig();
      const since = new Date(Date.now() - 24 * 3_600_000);
      const usedToday = await countReportsSince(ctx, since);
      if (usedToday >= cfg.reportsPerAccountPerDay) {
        throw rateLimited(3_600, 'Too many reports today; please try again tomorrow', { limit: cfg.reportsPerAccountPerDay });
      }

      if (body.reason === 'invalid_contact' && !body.assertionId) {
        throw new AppError('VALIDATION', 'assertionId is required to report an invalid contact', { field: 'assertionId' });
      }

      const entries = await byIds(ctx, 'profile', [body.companyId]);
      const entry = entries.get(body.companyId.toLowerCase() as Id<'company'>);
      if (!entry) throw new AppError('NOT_FOUND', 'Company not found');
      // LLD M27's own NOT_FOUND exception applies here too: a company this account has already
      // hidden (via an earlier report) has doc=null (M10 nulls the doc for any 'hidden'
      // decision), but the account must still be able to file further reports about it — e.g.
      // reporting a second, different contact as invalid_contact — not just the first time.
      // Anything hidden for another reason (suppressed, etc.) really is gone: NOT_FOUND stands.
      const onlyUserHidden =
        entry.decision.visibility === 'hidden' && entry.decision.reasons.length === 1 && entry.decision.reasons[0] === 'USER_HIDDEN';
      if (!entry.doc && !onlyUserHidden) throw new AppError('NOT_FOUND', 'Company not found');
      const doc = entry.doc;

      const targetKind: HideTargetKind = body.assertionId ? 'assertion' : 'company';
      const targetId = body.assertionId ?? body.companyId;

      let revealId: string | null = null;
      let state: ReportState;
      if (body.reason === 'invalid_contact') {
        const correlated = await findRevealForContact(ctx, body.assertionId!, body.companyId);
        revealId = correlated?.revealId ?? null;
        state = correlated ? 'reverifying' : 'closed';
      } else {
        state = 'review';
      }

      const reportId = newId<'report'>();

      // LLD M30 Rules: "A report always hides the target for that user, immediately. It does
      // this by inserting user_hide in the same tx" — this is the one write the LLD ties
      // together; everything below is a secondary effect, run after this commits.
      await scoped(ctx).transaction(async (db) => {
        await insertUserHide(db, accountId, targetKind, targetId);
        await insertReport(db, accountId, {
          id: reportId,
          companyId: body.companyId,
          assertionId: body.assertionId ?? null,
          reason: body.reason,
          note: body.note ?? null,
          revealId,
          state,
        });
      });

      // EV-13, and (for content reports) the M11 filing: a separate systemDb transaction, the
      // same pattern M29 uses for its own M02 calls (enqueueBulkJob), because ScopedDb does not
      // expose the raw Tx that emit()/file() need.
      await systemDb('m30: report side-effects')
        .transaction()
        .execute(async (tx: Tx) => {
          await emit(tx, EV_REPORT_FILED, {
            v: 1,
            reportId,
            accountId,
            companyId: body.companyId,
            assertionId: body.assertionId ?? null,
            reason: body.reason,
          });

          if (isContentReason(body.reason)) {
            const payload: ReportContentPayload = {
              companyId: body.companyId,
              reason: body.reason,
              hsHeading: primaryHsHeading(doc),
              count: 1,
            };
            const itemId = await file(tx, REPORT_CONTENT_TYPE, {
              subjectRefs: [{ kind: 'company', id: body.companyId }],
              payload,
              filedBy: { kind: 'user', ref: accountId },
              dedupeKey: `${body.companyId}:${body.reason}`,
            });
            const liveCount = await countReportsForCompanyReason(tx, body.companyId, body.reason);
            await bumpReviewItemCount(tx, itemId, liveCount);
            await setReportReviewItemIdTx(tx, reportId, itemId);
          }
        });

      if (body.reason === 'invalid_contact' && body.assertionId) {
        // Best-effort: check right now instead of waiting for the 90-day staleness cycle (LLD:
        // "M25 re-verify runs as a job" / "raises the re-verification priority"). The refund
        // decision is made asynchronously off EV-06 (see jobs.ts/refunds.ts), never off this
        // call's return value, so a slow or failed RPC here only delays freshness.
        try {
          await reverify(ctx, [body.assertionId], 'report', reportId);
        } catch (err) {
          log.warn({ err, reportId, assertionId: body.assertionId }, 'm30: post-report reverify kick failed');
        }
      }

      const refundStatus = state === 'reverifying' ? ('pending' as const) : ('not_applicable' as const);
      return { reportId, hidden: true as const, refundStatus };
    },
    { companyId: body.companyId, reason: body.reason },
  );
}

function parseHideKind(raw: unknown): HideTargetKind {
  if (typeof raw !== 'string' || !HIDE_TARGET_KINDS.includes(raw as HideTargetKind)) {
    throw new AppError('VALIDATION', `kind must be one of ${HIDE_TARGET_KINDS.join(', ')}`, { field: 'kind' });
  }
  return raw as HideTargetKind;
}

function parseHideId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new AppError('VALIDATION', 'id must be a uuid', { field: 'id' });
  }
  return raw.toLowerCase();
}

/** IF-30a `DELETE /api/hides/:kind/:id`. Idempotent: removing an already-absent hide is a no-op. */
export async function deleteHide(ctx: ActorContext, rawKind: unknown, rawId: unknown): Promise<void> {
  requireMember(ctx);
  const kind = parseHideKind(rawKind);
  const id = parseHideId(rawId);
  await deleteUserHide(ctx, kind, id);
}
