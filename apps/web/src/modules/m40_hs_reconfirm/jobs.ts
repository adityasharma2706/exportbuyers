/**
 * M40 — EV-12 wiring and the batch scan.
 *
 *   EV-12 nomenclature.version_loaded {version}  ->  enqueues m40.flag_workspaces. The fan-out
 *     is kept off the event's own transaction: a nomenclature reload can touch every workspace
 *     on the outgoing version across every account, so it runs as its own paginated job — the
 *     same shape as M30's reverify-timeout sweep.
 *   m40.flag_workspaces {version}  ->  for every live workspace whose hs_version is in the same
 *     family as `version` and differs from it: correlate(old, code, new); 1:1 with the same
 *     code -> silent update (and log it); otherwise -> hs_needs_reconfirm = true.
 *
 * Call registerHsReconfirmModule() once at boot (web and worker), before M02's syncRegistrations().
 */
import { z } from 'zod';
import { isAppError, log } from '../m01_platform/index.js';
import { NonRetryable, enqueue, registerEventSchema, registerHandler, subscribe, type EventMeta, type JobMeta } from '../m02_queue/index.js';
import { EV_NOMENCLATURE_VERSION_LOADED, correlate, versionFamily, type HsCorrelationResult, type NomenclatureVersionLoaded } from '../m12_hs/index.js';
import { hsReconfirmConfig } from './config.js';
import { decideOutcome } from './decide.js';
import { flagForReconfirm, nextBatch, updateVersionSilently } from './repo.js';
import { FLAG_WORKSPACES_JOB, type FlagWorkspacesPayload, type WorkspaceHsScanRow } from './types.js';

const versionLoadedSchema = z.object({ version: z.string().min(1) });
const flagWorkspacesSchema = z.object({ v: z.literal(1), version: z.string().min(1) });

async function onVersionLoaded(payload: NomenclatureVersionLoaded, meta: EventMeta): Promise<void> {
  try {
    versionFamily(payload.version); // format check only ('HS'|'ITCHS' + 4 digits); throws on a malformed version
  } catch (e) {
    throw new NonRetryable(`m40: malformed nomenclature version "${payload.version}"`, { cause: e });
  }
  const job: FlagWorkspacesPayload = { v: 1, version: payload.version };
  await enqueue(meta.tx, {
    type: FLAG_WORKSPACES_JOB,
    queue: 'serving',
    payload: job,
    // One scan per event: redelivery of the same nomenclature-loaded event (LLD §0.5 outbox
    // semantics) must not requeue a second scan once the first is running or done.
    idempotencyKey: `m40:flag:${meta.eventId}`,
  });
}

async function correlateOrEmpty(oldVersion: string, code: string, newVersion: string): Promise<HsCorrelationResult[]> {
  try {
    return await correlate(oldVersion, code, newVersion);
  } catch (e) {
    // No correlation table loaded between the two versions: treat as "no candidates" rather than
    // failing the scan — the workspace is flagged and the user searches for a fresh code.
    if (isAppError(e) && e.code === 'NOT_FOUND') return [];
    throw e;
  }
}

async function processOne(ws: WorkspaceHsScanRow, newVersion: string): Promise<'updated' | 'flagged'> {
  const candidates = await correlateOrEmpty(ws.hs_version, ws.hs_code, newVersion);
  const decision = decideOutcome(ws.hs_code, candidates);
  if (decision === 'silent_update') {
    await updateVersionSilently(ws.id, newVersion);
    log.info(
      { workspaceId: ws.id, accountId: ws.account_id, code: ws.hs_code, from: ws.hs_version, to: newVersion },
      'm40: HS code carried over silently to the new nomenclature version (1:1 match)',
    );
    return 'updated';
  }
  await flagForReconfirm(ws.id);
  return 'flagged';
}

/** Runs one full scan pass for `version`; exported for tests and manual/administrative operation. */
export async function runFlagWorkspaces(
  version: string,
  batchSize: number = hsReconfirmConfig().scanBatchSize,
): Promise<{ updated: number; flagged: number; failed: number }> {
  const family = versionFamily(version);
  let cursor: string | null = null;
  let updated = 0;
  let flagged = 0;
  let failed = 0;
  for (;;) {
    const batch = await nextBatch(family, version, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ws of batch) {
      try {
        const outcome = await processOne(ws, version);
        if (outcome === 'updated') updated += 1;
        else flagged += 1;
      } catch (err) {
        failed += 1;
        log.error({ err, workspaceId: ws.id }, 'm40: failed to re-check a workspace HS code after a nomenclature version change');
      }
    }
    cursor = batch[batch.length - 1]!.id;
    if (batch.length < batchSize) break;
  }
  if (updated + flagged + failed > 0) log.info({ version, updated, flagged, failed }, 'm40: nomenclature re-check pass complete');
  return { updated, flagged, failed };
}

let registered = false;

export function registerHsReconfirmModule(): void {
  if (registered) return;
  registerEventSchema(EV_NOMENCLATURE_VERSION_LOADED, versionLoadedSchema);
  subscribe(EV_NOMENCLATURE_VERSION_LOADED, 'm40.enqueue_flag_scan', onVersionLoaded);
  registerHandler(FLAG_WORKSPACES_JOB, flagWorkspacesSchema, async (payload: FlagWorkspacesPayload, _meta: JobMeta) => {
    await runFlagWorkspaces(payload.version);
  });
  registered = true;
}

/** Test hook. */
export function resetHsReconfirmModuleForTesting(): void {
  registered = false;
}

/**
 * [deviation: EV-12 `nomenclature.version_loaded` is emitted by the Python knowledge plane (M12's
 * own header comment: "the loaders ... emit EV-12"); M12's TS side exports only the payload type
 * (`NomenclatureVersionLoaded`), without registering the event in M02's `EventRegistry`. M40 is
 * its first TS subscriber, so — matching M39's precedent for the identical situation with EV-05
 * `discovery.completed` — the augmentation is added here rather than in M12.]
 */
declare module '../m02_queue/types.js' {
  interface EventRegistry {
    'nomenclature.version_loaded': NomenclatureVersionLoaded;
  }
}
