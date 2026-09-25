/**
 * M02 — SQL for platform.job / outbox / subscription / schedule / rate_class / event_handled.
 * Every function takes the handle to run on, so callers control the transaction boundary.
 */
import { sql } from 'kysely';
import type { Db } from '../m01_platform/index.js';
import type { RateClass } from './rate.js';
import type { RegisteredRateClassRow, OutboxRow, ScheduleRow, SubscriptionRow } from './rows.js';
import type { JobRow, QueueName } from './types.js';

/** Minimal shape of a Kysely RawBuilder, so this file does not depend on Kysely's generics. */
interface RawQuery {
  execute(db: Db): Promise<{ rows: unknown[]; numAffectedRows?: bigint }>;
}

async function rows<R>(db: Db, query: RawQuery): Promise<R[]> {
  const res = await query.execute(db);
  return res.rows as R[];
}

/** Lease length for a claimed job (LLD: 5 minutes). */
export const LEASE_SECONDS = 300;

// ---- job insert ------------------------------------------------------------------------

export interface JobInsert {
  id: string;
  queue: QueueName;
  type: string;
  payloadJson: string;
  v: number;
  idempotencyKey: string;
  correlationId: string;
  actorRef: string | null;
  rateClass: string | null;
  maxAttempts: number;
  runAt: Date | null;
}

/**
 * INSERT … ON CONFLICT (type, idempotency_key) DO NOTHING RETURNING id; on a conflict the
 * existing id is returned. Under concurrent inserts Postgres makes the loser wait for the
 * winner's transaction, so the follow-up SELECT (a fresh READ COMMITTED snapshot) sees it.
 */
export async function insertJob(db: Db, j: JobInsert): Promise<{ id: string; created: boolean }> {
  const inserted = await rows<{ id: string }>(
    db,
    sql`insert into platform.job
          (id, queue, type, payload, v, idempotency_key, correlation_id, actor_ref, rate_class, max_attempts, run_at)
        values
          (${j.id}, ${j.queue}, ${j.type}, ${j.payloadJson}::jsonb, ${j.v}, ${j.idempotencyKey}, ${j.correlationId},
           ${j.actorRef}, ${j.rateClass}, ${j.maxAttempts}, coalesce(${j.runAt}::timestamptz, now()))
        on conflict (type, idempotency_key) do nothing
        returning id`,
  );
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const existing = await rows<{ id: string }>(
    db,
    sql`select id from platform.job where type = ${j.type} and idempotency_key = ${j.idempotencyKey}`,
  );
  if (!existing[0]) {
    // The conflicting row was inserted by a transaction that then rolled back; our insert
    // did nothing, so retry it once.
    const retry = await rows<{ id: string }>(
      db,
      sql`insert into platform.job
            (id, queue, type, payload, v, idempotency_key, correlation_id, actor_ref, rate_class, max_attempts, run_at)
          values
            (${j.id}, ${j.queue}, ${j.type}, ${j.payloadJson}::jsonb, ${j.v}, ${j.idempotencyKey}, ${j.correlationId},
             ${j.actorRef}, ${j.rateClass}, ${j.maxAttempts}, coalesce(${j.runAt}::timestamptz, now()))
          on conflict (type, idempotency_key) do update set updated_at = platform.job.updated_at
          returning id`,
    );
    return { id: retry[0]!.id, created: retry[0]!.id === j.id };
  }
  return { id: existing[0].id, created: false };
}

// ---- worker path -----------------------------------------------------------------------

/** Leases up to `limit` due jobs of the given types; increments attempts. */
export async function claimJobs(db: Db, queue: QueueName, types: readonly string[], limit: number): Promise<JobRow[]> {
  if (types.length === 0 || limit <= 0) return [];
  return rows<JobRow>(
    db,
    sql`with c as (
          select id from platform.job
           where queue = ${queue} and state = 'queued' and run_at <= now() and type = any(${[...types]}::text[])
           order by run_at
           limit ${limit}
           for update skip locked)
        update platform.job j
           set state = 'running',
               attempts = j.attempts + 1,
               locked_until = now() + make_interval(secs => ${LEASE_SECONDS}),
               updated_at = now()
          from c
         where j.id = c.id
        returning j.*`,
  );
}

/** Each fenced update matches only while this worker still owns the lease (same attempt). */
export async function markDone(db: Db, id: string, attempt: number): Promise<boolean> {
  const r = await rows<{ id: string }>(
    db,
    sql`update platform.job set state = 'done', locked_until = null, updated_at = now()
         where id = ${id} and state = 'running' and attempts = ${attempt}
        returning id`,
  );
  return r.length > 0;
}

export async function markRetry(db: Db, id: string, attempt: number, delayMs: number, error: string): Promise<boolean> {
  const r = await rows<{ id: string }>(
    db,
    sql`update platform.job
           set state = 'queued', locked_until = null, last_error = ${error},
               run_at = now() + make_interval(secs => ${delayMs / 1000}), updated_at = now()
         where id = ${id} and state = 'running' and attempts = ${attempt}
        returning id`,
  );
  return r.length > 0;
}

export async function markDead(db: Db, id: string, attempt: number, error: string): Promise<boolean> {
  const r = await rows<{ id: string }>(
    db,
    sql`update platform.job set state = 'dead', locked_until = null, last_error = ${error}, updated_at = now()
         where id = ${id} and state = 'running' and attempts = ${attempt}
        returning id`,
  );
  return r.length > 0;
}

/** Puts a claimed job back without consuming an attempt (rate limit / concurrency cap). */
export async function deferJob(db: Db, id: string, attempt: number, delayMs: number): Promise<boolean> {
  const r = await rows<{ id: string }>(
    db,
    sql`update platform.job
           set state = 'queued', locked_until = null, attempts = greatest(attempts - 1, 0),
               run_at = now() + make_interval(secs => ${delayMs / 1000}), updated_at = now()
         where id = ${id} and state = 'running' and attempts = ${attempt}
        returning id`,
  );
  return r.length > 0;
}

export async function extendLease(db: Db, id: string, attempt: number): Promise<boolean> {
  const r = await rows<{ id: string }>(
    db,
    sql`update platform.job set locked_until = now() + make_interval(secs => ${LEASE_SECONDS}), updated_at = now()
         where id = ${id} and state = 'running' and attempts = ${attempt}
        returning id`,
  );
  return r.length > 0;
}

export async function countRunningInClass(db: Db, rateClass: string): Promise<number> {
  const r = await rows<{ n: number | string }>(
    db,
    sql`select count(*)::int as n from platform.job where state = 'running' and rate_class = ${rateClass}`,
  );
  return Number(r[0]?.n ?? 0);
}

// ---- leader duties ---------------------------------------------------------------------

/** Transaction-scoped advisory lock; released automatically at commit/rollback. */
export async function tryXactLock(db: Db, key: number): Promise<boolean> {
  const r = await rows<{ ok: boolean }>(db, sql`select pg_try_advisory_xact_lock(${key}::bigint) as ok`);
  return r[0]?.ok === true;
}

/** Requeues (or dead-letters, when out of attempts) running jobs whose lease has expired. */
export async function reapExpired(db: Db, limit = 500): Promise<JobRow[]> {
  return rows<JobRow>(
    db,
    sql`with expired as (
          select id from platform.job
           where state = 'running' and locked_until < now()
           order by locked_until
           limit ${limit}
           for update skip locked)
        update platform.job j
           set state = case when j.attempts >= j.max_attempts then 'dead' else 'queued' end,
               run_at = now(),
               locked_until = null,
               last_error = 'lease expired during attempt ' || j.attempts,
               updated_at = now()
          from expired
         where j.id = expired.id
        returning j.*`,
  );
}

export async function lockUndispatchedOutbox(db: Db, limit: number): Promise<OutboxRow[]> {
  return rows<OutboxRow>(
    db,
    sql`select id, event_type, payload, v, correlation_id, created_at
          from platform.outbox
         where dispatched_at is null
         order by created_at
         limit ${limit}
         for update skip locked`,
  );
}

export async function subscriptionsFor(db: Db, eventTypes: readonly string[]): Promise<SubscriptionRow[]> {
  if (eventTypes.length === 0) return [];
  return rows<SubscriptionRow>(
    db,
    sql`select event_type, handler, queue from platform.subscription where event_type = any(${[...eventTypes]}::text[])`,
  );
}

export async function markDispatched(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`update platform.outbox set dispatched_at = now() where id = any(${[...ids]}::uuid[])`.execute(db);
}

export async function lockSchedules(db: Db): Promise<ScheduleRow[]> {
  return rows<ScheduleRow>(
    db,
    sql`select name, cron, job_type, payload, queue, last_enqueued_at from platform.schedule order by name for update skip locked`,
  );
}

export async function setScheduleLastEnqueued(db: Db, name: string, at: Date): Promise<void> {
  await sql`update platform.schedule set last_enqueued_at = ${at}::timestamptz, updated_at = now() where name = ${name}`.execute(db);
}

export async function staleQueuedJobs(db: Db, olderThanSeconds: number): Promise<
  Array<{ type: string; queue: QueueName; count: number | string; oldest: Date | string }>
> {
  return rows(
    db,
    sql`select type, queue, count(*)::int as count, min(run_at) as oldest
          from platform.job
         where state = 'queued' and run_at < now() - make_interval(secs => ${olderThanSeconds})
         group by type, queue`,
  );
}

// ---- outbox ----------------------------------------------------------------------------

export async function insertOutbox(
  db: Db,
  e: { id: string; eventType: string; payloadJson: string; v: number; correlationId: string },
): Promise<void> {
  await sql`insert into platform.outbox (id, event_type, payload, v, correlation_id)
            values (${e.id}, ${e.eventType}, ${e.payloadJson}::jsonb, ${e.v}, ${e.correlationId})`.execute(db);
}

/** Records (event_id, handler); returns false when the pair was already handled. */
export async function markEventHandled(db: Db, eventId: string, handler: string): Promise<boolean> {
  const r = await rows<{ event_id: string }>(
    db,
    sql`insert into platform.event_handled (event_id, handler) values (${eventId}::uuid, ${handler})
        on conflict (event_id, handler) do nothing
        returning event_id`,
  );
  return r.length > 0;
}

// ---- boot sync -------------------------------------------------------------------------

export async function upsertSchedule(
  db: Db,
  s: { name: string; cron: string; jobType: string; payloadJson: string; queue: QueueName },
): Promise<void> {
  await sql`insert into platform.schedule (name, cron, job_type, payload, queue)
            values (${s.name}, ${s.cron}, ${s.jobType}, ${s.payloadJson}::jsonb, ${s.queue})
            on conflict (name) do update
              set cron = excluded.cron, job_type = excluded.job_type, payload = excluded.payload,
                  queue = excluded.queue, updated_at = now()`.execute(db);
}

export async function upsertSubscription(db: Db, s: { eventType: string; handler: string; queue: QueueName }): Promise<void> {
  await sql`insert into platform.subscription (event_type, handler, queue)
            values (${s.eventType}, ${s.handler}, ${s.queue})
            on conflict (event_type, handler) do update set queue = excluded.queue, updated_at = now()`.execute(db);
}

export async function upsertRateClass(db: Db, rc: RateClass): Promise<void> {
  await sql`insert into platform.rate_class (name, max_concurrency, per_second)
            values (${rc.name}, ${rc.maxConcurrency}, ${rc.perSecond})
            on conflict (name) do update
              set max_concurrency = excluded.max_concurrency, per_second = excluded.per_second,
                  updated_at = now()`.execute(db);
}

export async function loadRateClasses(db: Db): Promise<RateClass[]> {
  const r = await rows<RegisteredRateClassRow>(
    db,
    sql`select name, max_concurrency, per_second from platform.rate_class`,
  );
  return r.map((x) => ({ name: x.name, maxConcurrency: Number(x.max_concurrency), perSecond: Number(x.per_second) }));
}
