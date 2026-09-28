/**
 * M29 — the `m29.reveal_bulk` background job (LLD M29 Bulk: "If the batch is large, the request
 * is processed as a job and the UI polls GET /api/reveal/bulk/:id"). The job reconstructs an
 * ActorContext from the payload (a worker has no HTTP request to resolve a session from) and runs
 * the same `runBulkBatch` the inline path uses.
 */
import { z } from 'zod';
import { AppError, log, newId, type ActorContext } from '../m01_platform/index.js';
import { registerHandler, registerRateClass, type PayloadSchema } from '../m02_queue/index.js';
import { BULK_CONCURRENCY, BULK_JOB_TYPE, BULK_RATE_CLASS } from './config.js';
import { runBulkBatch } from './service.js';
import { updateRevealBulk } from './repo.js';
import type { BulkJobPayload } from './types.js';

const entitlementsSchema = z
  .object({
    plan: z.enum(['anonymous', 'free', 'starter', 'growth']),
    searchResultCap: z.number(),
    exportRowsPerMonth: z.number(),
    bulkRevealMax: z.number(),
    checksPerMonth: z.number(),
    revealsIncludedPerMonth: z.number(),
  })
  .strict();

const bulkJobSchema = z
  .object({
    v: z.literal(1),
    bulkId: z.string().uuid(),
    accountId: z.string().uuid(),
    memberId: z.string().uuid(),
    workspaceId: z.string().uuid().optional(),
    role: z.string().optional(),
    region: z.string().min(2).max(2),
    locale: z.enum(['en', 'hi']),
    mfaVerified: z.boolean(),
    entitlements: entitlementsSchema,
    allCompanyIds: z.array(z.string().uuid()).min(1),
    alreadyRevealedIds: z.array(z.string().uuid()),
    toProcess: z.array(z.string().uuid()).min(1),
    holdId: z.string().uuid(),
    unitCredits: z.number().int().min(0),
    catalogueVersion: z.string().nullable(),
  })
  .strict();

const schema: PayloadSchema<BulkJobPayload> = {
  safeParse(input: unknown) {
    const r = bulkJobSchema.safeParse(input);
    return r.success ? { success: true, data: r.data as BulkJobPayload } : { success: false, error: { message: r.error.message } };
  },
};

function ctxFromPayload(p: BulkJobPayload): ActorContext {
  const ctx: ActorContext = {
    kind: 'user',
    accountId: p.accountId as ActorContext['accountId'],
    memberId: p.memberId as ActorContext['memberId'],
    entitlements: p.entitlements,
    locale: p.locale,
    region: p.region,
    mfaVerified: p.mfaVerified,
    correlationId: newId<'correlation'>(),
  };
  if (p.workspaceId) ctx.workspaceId = p.workspaceId as ActorContext['workspaceId'];
  if (p.role) ctx.role = p.role as ActorContext['role'];
  return ctx;
}

let registered = false;

/** Registers M29's bulk-reveal job handler. Call once at worker boot. */
export function registerRevealJobs(): void {
  if (registered) return;

  registerRateClass(BULK_RATE_CLASS, BULK_CONCURRENCY, 4);

  registerHandler(BULK_JOB_TYPE, schema, async (payload) => {
    const ctx = ctxFromPayload(payload);
    try {
      await runBulkBatch(
        ctx,
        payload.bulkId,
        payload.allCompanyIds,
        new Set(payload.alreadyRevealedIds),
        payload.toProcess,
        payload.holdId,
        payload.unitCredits,
        payload.catalogueVersion,
      );
    } catch (err) {
      log.error({ err, bulkId: payload.bulkId }, 'm29: bulk reveal job failed');
      await updateRevealBulk(ctx, payload.bulkId, {
        state: 'failed',
        error: err instanceof AppError ? err.message : 'Bulk reveal failed',
      }).catch((e: unknown) => log.error({ err: e, bulkId: payload.bulkId }, 'm29: failed to record a failed bulk reveal'));
      throw err;
    }
  });

  registered = true;
}

/** For tests. */
export function resetRevealJobsForTesting(): void {
  registered = false;
}
