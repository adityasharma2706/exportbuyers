/**
 * M07 — background jobs:
 *   m07.purge_workspaces  daily hard purge of workspaces soft-deleted more than 30 days ago
 *                         [tunable], plus expired idempotency records.
 * Rows in later modules that reference a workspace are expected to cascade or be cleaned by
 * their owners (M38 handles account-level erasure).
 */
import { log } from '../m01_platform/index.js';
import { registerHandler, registerSchedule, type PayloadSchema } from '../m02_queue/index.js';
import { tenancyConfig } from './config.js';
import { purgeDeletedWorkspaces, purgeIdempotency } from './repo.js';

export const PURGE_WORKSPACES_JOB = 'm07.purge_workspaces';

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

/** Runs one purge pass; exported for tests and manual operation. */
export async function runWorkspacePurge(now: Date = new Date()): Promise<{ workspaces: number; idempotency: number }> {
  const cfg = tenancyConfig();
  const cutoff = new Date(now.getTime() - cfg.purgeAfterDays * 24 * 3600 * 1000);
  const ids = await purgeDeletedWorkspaces(cutoff);
  const idempotency = await purgeIdempotency(new Date(now.getTime() - cfg.idempotencyTtlHours * 3600 * 1000));
  return { workspaces: ids.length, idempotency };
}

let registered = false;

/** Registers M07 job handlers and schedules with M02. Call once at worker boot. */
export function registerTenancyJobs(): void {
  if (registered) return;
  registerHandler(PURGE_WORKSPACES_JOB, purgeSchema, async () => {
    const r = await runWorkspacePurge();
    log.info(r, 'm07 purged soft-deleted workspaces and idempotency records');
  });
  registerSchedule('m07-purge-workspaces', '41 2 * * *', PURGE_WORKSPACES_JOB, { v: 1 }, 'serving');
  registered = true;
}
