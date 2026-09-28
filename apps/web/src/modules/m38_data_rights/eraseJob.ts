/**
 * M38 — the `m38.erase` job (LLD M38 "Rules: Erase").
 *   1. account.status='deleting', revoke all sessions, cancel the subscription (M36).
 *   2. Run contributors in order (registry.ts).
 *   3. Retention exceptions are returned by each contributor's erase() (types.ts).
 *   4. account.status='deleted'.
 * Every step is idempotent so a retried job (LLD: "jobs retrying on failure") is safe to re-run
 * from the top; a contributor throwing lets the job fail and retry (M02 backoff), and after
 * ERASE_MAX_ATTEMPTS the job dead-letters through M02's onDeadLetter -> M11 hook (LLD: "Failed
 * contributors dead-letter to M11") without M38 depending on M11 directly.
 */
import { sql } from 'kysely';
import { AppError, log, systemDb, withSpan } from '../m01_platform/index.js';
import { registerHandler, registerRateClass, type PayloadSchema } from '../m02_queue/index.js';
import { cancelSubscriptionIfAny } from './contributors.js';
import { ERASE_JOB_TYPE, ERASE_MAX_ATTEMPTS, RIGHTS_RATE_CLASS } from './config.js';
import { listContributorsOrdered } from './registry.js';
import { markRequestDone, setRequestState } from './repo.js';

export interface EraseJobPayload {
  v: 1;
  requestId: string;
  accountId: string;
}

const schema: PayloadSchema<EraseJobPayload> = {
  safeParse(input: unknown) {
    if (input === null || typeof input !== 'object') return { success: false, error: { message: 'payload must be an object' } };
    const o = input as Record<string, unknown>;
    if (o.v !== 1 || typeof o.requestId !== 'string' || typeof o.accountId !== 'string') {
      return { success: false, error: { message: 'payload must be {v:1, requestId, accountId}' } };
    }
    return { success: true, data: { v: 1, requestId: o.requestId, accountId: o.accountId } };
  },
};

async function setAccountStatus(accountId: string, status: 'deleting' | 'deleted'): Promise<void> {
  await sql`update serving.account set status = ${status} where id = ${accountId}`.execute(systemDb(`m38: set account status ${status}`));
}

async function revokeAllSessions(accountId: string): Promise<void> {
  await sql`
    delete from serving.session
    where member_id in (select id from serving.member where account_id = ${accountId})
  `.execute(systemDb('m38: revoke all sessions'));
}

export async function runErase(payload: EraseJobPayload): Promise<void> {
  const { accountId, requestId } = payload;
  await withSpan(
    'm38.erase',
    async () => {
      await setRequestState(requestId, 'running');

      // Step 1 (LLD Rules: "Set account.status='deleting', revoke all sessions, cancel the
      // subscription (M36)"). Idempotent: re-running on retry is a harmless no-op.
      await setAccountStatus(accountId, 'deleting');
      await revokeAllSessions(accountId);
      await cancelSubscriptionIfAny(accountId);

      // Step 2: contributors, in order. Each contributor is expected to be idempotent (it must
      // tolerate re-running after a previous attempt partially succeeded).
      const retained: string[] = [];
      for (const contributor of listContributorsOrdered()) {
        try {
          const result = await contributor.erase(accountId);
          if (result.retained) retained.push(...result.retained);
        } catch (err) {
          log.error({ err, accountId, requestId, contributor: contributor.module }, 'm38: erase contributor failed');
          throw err instanceof AppError ? err : new AppError('INTERNAL', `Erase contributor ${contributor.module} failed`, undefined, { cause: err });
        }
      }

      // Step 4: account.status='deleted'.
      await setAccountStatus(accountId, 'deleted');
      await markRequestDone(requestId, null, new Date());
      log.info({ accountId, requestId, retained }, 'm38: erase complete');
    },
    { accountId, requestId },
  ).catch(async (err: unknown) => {
    await setRequestState(requestId, 'failed').catch((e: unknown) => log.error({ err: e, requestId }, 'm38: failed to mark erase request failed'));
    throw err;
  });
}

let registered = false;

/** Registers M38's `m38.erase` job handler. Call once at worker boot. */
export function registerEraseJob(): void {
  if (registered) return;
  registerRateClass(RIGHTS_RATE_CLASS, 4, 2);
  registerHandler(ERASE_JOB_TYPE, schema, async (payload) => {
    await runErase(payload);
  });
  registered = true;
}

/** For tests. */
export function resetEraseJobForTesting(): void {
  registered = false;
}

export { ERASE_MAX_ATTEMPTS };
