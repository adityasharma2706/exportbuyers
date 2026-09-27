/**
 * M18 — serving-plane side of entity merge reviews (M11 IF-11a / IF-11b). REQ-064.
 *
 *   knowledge plane resolve() ──enqueue──▶ `m18.file_merge_review` (serving queue)
 *        ──▶ M11 file('entity.merge_review', dedupeKey = '<lo>:<hi>' of the company pair)
 *   admin resolves:
 *        • `merge`    ──▶ M09 IF-09b `merge_confirm` {subject b, into a}: b.merged_into = a, anchors
 *                         moved, assertions re-pointed, EV-01 for a (REQ-021: one profile per company)
 *        • `distinct` ──▶ M09 IF-09b `merge_reject` (records the pair as distinct so it is not
 *                         filed again)
 *
 * `a` is the company that survives a merge; `b` is the suspected duplicate (for fuzzy reviews the
 * newly created company, for anchor conflicts the company holding the lower-ranked anchor).
 */
import { z } from 'zod';
import { log, systemDb } from '../m01_platform/index.js';
import { registerHandler, type JobMeta, type Tx } from '../m02_queue/index.js';
import { DEFAULT_SLA_HOURS, file, registerType, sendAssertionCommand } from '../m11_review/index.js';

export const MERGE_REVIEW_TYPE = 'entity.merge_review';
export const FILE_MERGE_REVIEW_JOB = 'm18.file_merge_review';
export const MERGE_OUTCOMES = ['merge', 'distinct'] as const;
export type MergeOutcome = (typeof MERGE_OUTCOMES)[number];

/** [assumption] The LLD sets no SLA for merge reviews; they share the report SLA (5 days). */
export const MERGE_REVIEW_SLA_HOURS: number = DEFAULT_SLA_HOURS.report;

const ANCHOR_KINDS = ['lei', 'registry', 'vat', 'domain'] as const;

export const mergeReviewPayloadSchema = z
  .object({
    a: z.string().uuid(),
    b: z.string().uuid(),
    score: z.number().min(0).max(1),
    reason: z.enum(['fuzzy', 'anchor_conflict']),
    country: z.string().regex(/^[A-Z]{2}$/),
    aName: z.string().min(1).max(500),
    bName: z.string().min(1).max(500),
    sourceId: z.string().min(1).max(200),
    signals: z
      .object({
        nameSim: z.number().min(0).max(1),
        cityMatch: z.number().min(0).max(1),
        addressOverlap: z.number().min(0).max(1),
      })
      .nullable(),
    conflictingAnchors: z.array(z.enum(ANCHOR_KINDS)).max(4),
  })
  .refine((p) => p.a.toLowerCase() !== p.b.toLowerCase(), { message: 'a and b must be different companies' });
export type MergeReviewPayload = z.infer<typeof mergeReviewPayloadSchema>;

export const mergeReviewOutcomeSchema = z.object({ note: z.string().max(2000).optional() });
export type MergeReviewOutcome = z.infer<typeof mergeReviewOutcomeSchema>;

function isMergeOutcome(o: string): o is MergeOutcome {
  return (MERGE_OUTCOMES as readonly string[]).includes(o);
}

/** The pair key used for M11 dedupe: order-independent, so (a, b) and (b, a) share one item. */
export function pairKey(a: string, b: string): string {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x <= y ? `${x}:${y}` : `${y}:${x}`;
}

/** Files (or, on a dedupe hit, finds) the open merge review for a company pair. */
export async function fileMergeReview(tx: Tx, p: MergeReviewPayload): Promise<string> {
  return file(tx, MERGE_REVIEW_TYPE, {
    subjectRefs: [
      { kind: 'company', id: p.a },
      { kind: 'company', id: p.b },
    ],
    payload: p,
    filedBy: { kind: 'system', ref: 'm18.resolution' },
    dedupeKey: pairKey(p.a, p.b),
  });
}

async function onFileMergeReview(p: MergeReviewPayload, meta: JobMeta): Promise<void> {
  const id = await systemDb('m18 file entity merge review')
    .transaction()
    .execute(async (tx: Tx) => fileMergeReview(tx, p));
  log.info({ a: p.a, b: p.b, score: p.score, reason: p.reason, reviewItemId: id, jobId: meta.jobId }, 'm18 merge review filed');
}

let registered = false;

/** Registers the review type and the filing job. Call at boot (web and worker), before M02's syncRegistrations(). */
export function registerResolutionModule(): void {
  if (registered) return;
  registerType<MergeReviewPayload, MergeReviewOutcome>({
    type: MERGE_REVIEW_TYPE,
    payloadSchema: mergeReviewPayloadSchema,
    outcomes: MERGE_OUTCOMES,
    outcomeSchema: mergeReviewOutcomeSchema,
    slaHours: MERGE_REVIEW_SLA_HOURS,
    requiredRole: 'admin_ops',
    rejectingOutcomes: ['distinct'],
    view: {
      titleKey: 'admin.review.entityMerge.title',
      fields: [
        { path: 'aName', labelKey: 'admin.review.entityMerge.keep' },
        { path: 'bName', labelKey: 'admin.review.entityMerge.duplicate' },
        { path: 'country', labelKey: 'admin.review.entityMerge.country' },
        { path: 'score', labelKey: 'admin.review.entityMerge.score' },
        { path: 'reason', labelKey: 'admin.review.entityMerge.reason' },
        { path: 'signals', labelKey: 'admin.review.entityMerge.signals', format: 'json' },
        { path: 'conflictingAnchors', labelKey: 'admin.review.entityMerge.anchors', format: 'json' },
        { path: 'sourceId', labelKey: 'admin.review.entityMerge.source' },
      ],
      outcomeLabelKeys: { merge: 'admin.review.entityMerge.merge', distinct: 'admin.review.entityMerge.distinct' },
      confirmOutcomes: ['merge'],
    },
    onOutcome: async (item, outcome, data, tx: Tx) => {
      if (!isMergeOutcome(outcome)) return; // M11 validates outcomes; defensive only
      const { a, b } = item.payload;
      // IF-09b: subject is the duplicate (b); payload.into is the survivor (a).
      await sendAssertionCommand(tx, item, {
        kind: outcome === 'merge' ? 'merge_confirm' : 'merge_reject',
        subjectId: b,
        payload: { into: a },
      });
      log.info({ itemId: item.id, a, b, outcome, note: data.note }, 'm18 merge review decided');
    },
  });
  registerHandler(FILE_MERGE_REVIEW_JOB, mergeReviewPayloadSchema, onFileMergeReview);
  registered = true;
}

export function resetResolutionModuleForTesting(): void {
  registered = false;
}
