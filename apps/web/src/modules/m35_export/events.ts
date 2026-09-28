/**
 * M35 — EV-04 handler (LLD M35: "EV-04 handler: cancel exports in queued or running state.
 * Delete ready files whose source contained a suppressed company."). M10's suppress() comment
 * names M35 as one of the EV-04 handlers ("M10 here, M09, M26, M35"), each removing what it
 * itself keeps a copy of.
 *
 * `purgeSuppressed` (M10 IF-10d's own EV-04 purge) is reused here rather than re-deriving which
 * companies the suppressed hashes matched: it is idempotent (the delete and the m09.project
 * re-projection it enqueues both key off the same event id M10's own "m10.purge" handler uses),
 * and it is the only public way to learn which company ids a batch of suppressed identifier
 * hashes actually resolved to (M10 exposes no other hash -> company lookup).
 */
import { z } from 'zod';
import { log } from '../m01_platform/index.js';
import { subscribe, type EventMeta } from '../m02_queue/index.js';
import { EV_SUPPRESSION_ADDED, purgeSuppressed } from '../m10_policy/index.js';
import { cancelInFlightExports, markExportCancelledAfterSuppression, readyExportsCarryingCompanies } from './repo.js';
import { deleteExportObject } from './presign.js';

const HASH_RE = /^[0-9a-f]{64}$/;
const payloadSchema = z.object({ hashes: z.array(z.string().regex(HASH_RE)).min(1).max(10_000) });

async function onSuppressionAdded(payload: unknown, meta: EventMeta): Promise<void> {
  const parsed = payloadSchema.safeParse(payload);
  const hashes = parsed.success ? parsed.data.hashes : [];
  const now = new Date();

  const cancelled = await cancelInFlightExports(meta.tx, now);
  if (cancelled > 0) log.info({ cancelled, eventId: meta.eventId }, 'm35: cancelled in-flight exports on suppression');

  if (hashes.length === 0) return;
  const purgedCompanyIds = await purgeSuppressed(meta.tx, hashes, meta.eventId);
  if (purgedCompanyIds.length === 0) return;

  const carrying = await readyExportsCarryingCompanies(meta.tx, purgedCompanyIds);
  for (const exp of carrying) {
    if (exp.s3_key) {
      await deleteExportObject(exp.s3_key).catch((err: unknown) =>
        log.error({ err, exportId: exp.id, s3Key: exp.s3_key }, 'm35: failed to delete a suppressed export file from object storage'),
      );
    }
    await markExportCancelledAfterSuppression(meta.tx, exp.id, now);
  }
  log.info({ count: carrying.length, eventId: meta.eventId }, 'm35: deleted ready exports carrying a suppressed company');
}

let registered = false;

/** Registers M35's EV-04 subscription. Call once at worker boot (alongside registerExportBuildJob()). */
export function registerExportSuppressionHandler(): void {
  if (registered) return;
  subscribe(EV_SUPPRESSION_ADDED, 'm35.export_suppression_check', onSuppressionAdded);
  registered = true;
}

/** For tests. */
export function resetExportSuppressionHandlerForTesting(): void {
  registered = false;
}
