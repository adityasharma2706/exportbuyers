/**
 * M05 — background jobs:
 *   m05.send_email      retries transactional email sends (see vendors.ts)
 *   m05.purge_expired   hourly removal of expired sessions and OTP challenges
 */
import { log } from '../m01_platform/index.js';
import { registerHandler, registerSchedule, type PayloadSchema } from '../m02_queue/index.js';
import { deleteExpiredChallenges, deleteExpiredSessions } from './repo.js';
import { registerEmailJob } from './vendors.js';

export const PURGE_JOB = 'm05.purge_expired';

/** OTP challenge rows are kept for a day after expiry for abuse investigation [tunable]. */
const CHALLENGE_RETENTION_MS = 24 * 3600 * 1000;

interface PurgePayload {
  v: 1;
}

const purgeSchema: PayloadSchema<PurgePayload> = {
  safeParse(input: unknown) {
    if (input !== null && typeof input === 'object' && (input as { v?: unknown }).v === 1) {
      return { success: true as const, data: { v: 1 as const } };
    }
    return { success: false as const, error: { message: 'payload must be {v:1}' } };
  },
};

let registered = false;

/** Registers M05 job handlers and schedules with M02. Call once at worker boot. */
export function registerIdentityJobs(): void {
  if (registered) return;
  registerEmailJob();
  registerHandler(PURGE_JOB, purgeSchema, async () => {
    const now = new Date();
    const sessions = await deleteExpiredSessions(now);
    const challenges = await deleteExpiredChallenges(new Date(now.getTime() - CHALLENGE_RETENTION_MS));
    log.info({ sessions, challenges }, 'm05 purged expired sessions and otp challenges');
  });
  registerSchedule('m05-purge-expired', '17 * * * *', PURGE_JOB, { v: 1 }, 'serving');
  registered = true;
}
