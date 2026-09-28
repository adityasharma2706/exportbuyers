/**
 * M28 — background jobs (LLD M28 Rules):
 *   m28.sweep_expired_holds  every minute; releases any hold whose expires_at has passed and
 *                            that has no commit or release yet.
 *   m28.monthly_free_grant   scheduled daily at 18:35 UTC (= 00:05 IST the next day); the handler
 *                            only acts when that instant lands on the 1st of the IST month, since
 *                            M02's cron grammar has no "last day of month" primitive. Grants
 *                            free.monthly_credits [tunable] to every active account and expires
 *                            any unspent balance of the previous month's free grant.
 */
import { sql } from 'kysely';
import { log, type ActorContext } from '../m01_platform/index.js';
import { registerHandler, registerSchedule, type PayloadSchema } from '../m02_queue/index.js';
import { creditsConfig } from './config.js';
import { systemExec, type Exec } from './exec.js';
import { computeGrantRemaining, expireGrantIfDue, grant, mapEntry, performRelease } from './ledger.js';
import { endOfIstMonthUtc, istDateParts } from './time.js';
import type { EntryRow } from './types.js';

export const SWEEP_HOLDS_JOB = 'm28.sweep_expired_holds';
export const MONTHLY_GRANT_JOB = 'm28.monthly_free_grant';

/** Actor used for every write the scheduler makes on an account's behalf. */
const SYSTEM_CTX: ActorContext = {
  kind: 'system',
  entitlements: { plan: 'anonymous', searchResultCap: 0, exportRowsPerMonth: 0, bulkRevealMax: 0, checksPerMonth: 0, revealsIncludedPerMonth: 0 },
  locale: 'en',
  region: 'IN',
  mfaVerified: false,
  correlationId: 'm28-scheduler',
};

const v1Schema: PayloadSchema<{ v: 1 }> = {
  safeParse(input: unknown) {
    if (input !== null && typeof input === 'object' && (input as { v?: unknown }).v === 1) {
      return { success: true as const, data: { v: 1 as const } };
    }
    return { success: false as const, error: { message: 'payload must be {v:1}' } };
  },
};

/** Runs one sweep pass; exported for tests and manual operation. Returns holds released. */
export async function sweepExpiredHolds(now: Date = new Date()): Promise<number> {
  const exec = systemExec('sweep expired holds');
  const batch = creditsConfig().sweepBatchSize;
  const rows = await exec.run(sql<Record<string, unknown>>`
    select e.* from ledger.entry e
    where e.kind = 'hold' and e.bucket = 'held' and e.expires_at is not null and e.expires_at <= ${now}
      and not exists (select 1 from ledger.entry t where t.refers_to = e.id and t.kind in ('commit', 'release'))
    order by e.expires_at asc
    limit ${batch}
  `);

  let released = 0;
  for (const raw of rows) {
    const holdRow: EntryRow = mapEntry(raw);
    try {
      await exec.transaction(async (tx) => {
        await performRelease(tx, holdRow.accountId, holdRow);
      });
      released++;
    } catch (err) {
      log.error({ err, holdId: holdRow.id, accountId: holdRow.accountId }, 'm28: failed to sweep an expired hold');
    }
  }
  return released;
}

async function activeAccountIds(exec: Exec, max: number): Promise<string[]> {
  // serving.account is M05's table; M28 does not otherwise depend on M05. This read-only
  // enumeration is the only way to run a scheduled, all-accounts grant without a dedicated
  // "list accounts" API, and mirrors M07's existing precedent (repo.ts#accountStatusOf) of
  // reading the shared account-root table via systemDb() for a narrow, documented purpose.
  const rows = await exec.run(sql<{ id: string }>`select id from serving.account where status = 'active' order by id asc limit ${max}`);
  if (rows.length >= max) {
    log.warn({ max }, 'm28: monthly free grant hit its per-run account cap; some accounts were skipped this run');
  }
  return rows.map((r) => String(r.id));
}

async function expirePastFreeGrants(exec: Exec, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
  const rows = await exec.run(sql<Record<string, unknown>>`
    select g.* from ledger.entry g
    where g.kind = 'grant' and g.bucket = 'available' and g.idempotency_key like 'free:%'
      and g.expires_at is not null and g.expires_at <= ${now} and g.expires_at >= ${cutoff}
      and not exists (select 1 from ledger.entry x where x.refers_to = g.id and x.kind = 'expiry')
  `);

  let expired = 0;
  for (const raw of rows) {
    const grantRow: EntryRow = mapEntry(raw);
    try {
      const amount = await exec.transaction((tx) => expireGrantIfDue(tx, grantRow));
      if (amount > 0) expired++;
    } catch (err) {
      log.error({ err, grantId: grantRow.id, accountId: grantRow.accountId }, 'm28: failed to expire a monthly free grant');
    }
  }
  return expired;
}

/** Runs one monthly-grant pass; a no-op unless `now` (interpreted in IST) is the 1st of the
 * month. Exported for tests and manual operation. */
export async function runMonthlyFreeGrant(now: Date = new Date()): Promise<{ granted: number; expired: number }> {
  const ist = istDateParts(now);
  if (ist.day !== 1) return { granted: 0, expired: 0 };

  const cfg = creditsConfig();
  const period = `${ist.year}-${String(ist.month).padStart(2, '0')}`;
  const expiresAt = endOfIstMonthUtc(ist.year, ist.month);
  const exec = systemExec('monthly free grant');

  const accountIds = await activeAccountIds(exec, cfg.monthlyGrantMaxAccounts);
  let granted = 0;
  for (const accountId of accountIds) {
    try {
      await grant(SYSTEM_CTX, {
        accountId,
        credits: cfg.freeMonthlyCredits,
        kind: 'grant',
        expiresAt,
        idempotencyKey: `free:${accountId}:${period}`,
        reason: 'monthly free grant',
      });
      granted++;
    } catch (err) {
      log.error({ err, accountId }, 'm28: failed to grant the monthly free credits');
    }
  }

  const expired = await expirePastFreeGrants(exec, now);
  return { granted, expired };
}

let registered = false;

/** Registers M28's job handlers and schedules with M02. Call once at worker boot. */
export function registerCreditsJobs(): void {
  if (registered) return;

  registerHandler(SWEEP_HOLDS_JOB, v1Schema, async () => {
    const n = await sweepExpiredHolds();
    if (n > 0) log.info({ released: n }, 'm28: swept expired holds');
  });
  registerSchedule('m28-sweep-expired-holds', '* * * * *', SWEEP_HOLDS_JOB, { v: 1 }, 'serving');

  registerHandler(MONTHLY_GRANT_JOB, v1Schema, async () => {
    const r = await runMonthlyFreeGrant();
    if (r.granted > 0 || r.expired > 0) log.info(r, 'm28: monthly free grant pass');
  });
  registerSchedule('m28-monthly-free-grant', '35 18 * * *', MONTHLY_GRANT_JOB, { v: 1 }, 'serving');

  registered = true;
}

/** For tests: computeGrantRemaining is re-exported so jobs.test.ts (if any) does not need to
 * reach into ledger.ts directly. */
export { computeGrantRemaining };
