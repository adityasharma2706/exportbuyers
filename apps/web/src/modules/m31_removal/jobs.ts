/**
 * M31 — module wiring: the `removal.request` review type, the requester-notification job, and a
 * daily sweep that purges old challenge rows (not part of the LLD's own schema — housekeeping for
 * a table whose rows are meaningful for at most `challengeRetentionDays`, see config.ts).
 *
 * Call registerRemovalModule() once at boot (web and worker), after M10 and M11 have loaded, and
 * before M02's syncRegistrations().
 */
import { z } from 'zod';
import { log, systemDb } from '../m01_platform/index.js';
import { registerHandler, registerSchedule } from '../m02_queue/index.js';
import { removalConfig } from './config.js';
import { registerNotifyJob } from './notify.js';
import { purgeExpiredChallenges } from './repo.js';
import { registerRemovalReviewType } from './reviewTypes.js';

export const PURGE_JOB = 'm31.purge_expired_challenges';
export const PURGE_SCHEDULE = 'm31-purge-expired-removal-challenges';
/** [tunable] batch size per sweep pass. */
const PURGE_BATCH_SIZE = 1000;

const purgePayloadSchema = z.object({ v: z.literal(1) });

/** Runs one sweep pass; exported for tests and manual operation. */
export async function runPurgeExpiredChallenges(now: Date = new Date()): Promise<{ purged: number }> {
  const cutoff = new Date(now.getTime() - removalConfig().challengeRetentionDays * 86_400_000);
  const purged = await purgeExpiredChallenges(systemDb('m31: purge expired removal challenges'), cutoff, PURGE_BATCH_SIZE);
  return { purged };
}

let registered = false;

export function registerRemovalModule(): void {
  if (registered) return;

  registerRemovalReviewType();
  registerNotifyJob();

  registerHandler(PURGE_JOB, purgePayloadSchema, async () => {
    const r = await runPurgeExpiredChallenges();
    if (r.purged > 0) log.info(r, 'm31: purged expired removal challenges');
  });
  registerSchedule(PURGE_SCHEDULE, '52 3 * * *', PURGE_JOB, { v: 1 }, 'serving');

  registered = true;
}

/** Test hook. */
export function resetRemovalModuleForTesting(): void {
  registered = false;
}
