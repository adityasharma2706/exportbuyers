/**
 * M41 — the reminders scheduler (LLD M41: "Scheduler: every 5 minutes, fire reminders with
 * due_at <= now"). Claims due `pending`/`snoozed` reminders (flipping them to `fired`, which
 * removes them from the firable set but keeps them visible on the dashboard until `complete()`),
 * then calls `notify()` for each — the in-app row, plus email if the account has opted in.
 */
import { log, systemDb } from '../m01_platform/index.js';
import { registerHandler, registerSchedule, type PayloadSchema } from '../m02_queue/index.js';
import { notifyConfig } from './config.js';
import { claimDueRemindersForFiring, companyIdForEntryUnscoped } from './repo.js';
import { notify } from './service.js';
import { NOTIFY_KIND_REMINDER_DUE, NOTIFY_TITLE_KEY_REMINDER_DUE } from './types.js';

export const FIRE_REMINDERS_JOB = 'm41.fire_reminders';

const v1Schema: PayloadSchema<{ v: 1 }> = {
  safeParse(input: unknown) {
    if (input !== null && typeof input === 'object' && (input as { v?: unknown }).v === 1) {
      return { success: true as const, data: { v: 1 as const } };
    }
    return { success: false as const, error: { message: 'payload must be {v:1}' } };
  },
};

/** Runs one firing pass; exported for tests and manual operation. Returns reminders fired. */
export async function fireDueReminders(now: Date = new Date()): Promise<number> {
  const db = systemDb('m41: fire due reminders');
  const claimed = await claimDueRemindersForFiring(db, now, notifyConfig().schedulerBatchSize);

  let fired = 0;
  for (const r of claimed) {
    try {
      const companyId = await companyIdForEntryUnscoped(db, r.entryId);
      await notify(r.accountId, {
        kind: NOTIFY_KIND_REMINDER_DUE,
        titleKey: NOTIFY_TITLE_KEY_REMINDER_DUE,
        params: { reminderId: r.id, entryId: r.entryId, reminderKind: r.kind },
        ...(companyId !== undefined ? { companyId } : {}),
      });
      fired++;
    } catch (err) {
      log.error({ err, reminderId: r.id, accountId: r.accountId }, 'm41: failed to notify for a fired reminder');
    }
  }
  return fired;
}

let registered = false;

/** Registers M41's job handler and schedule with M02. Call once at worker boot. */
export function registerNotifyJobs(): void {
  if (registered) return;

  registerHandler(FIRE_REMINDERS_JOB, v1Schema, async () => {
    const n = await fireDueReminders();
    if (n > 0) log.info({ fired: n }, 'm41: fired due reminders');
  });
  registerSchedule('m41-fire-reminders', '*/5 * * * *', FIRE_REMINDERS_JOB, { v: 1 }, 'serving');

  registered = true;
}

/** Test hook. */
export function resetNotifyJobsForTesting(): void {
  registered = false;
}
