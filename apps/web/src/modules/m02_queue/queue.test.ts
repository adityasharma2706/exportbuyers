/**
 * M02 acceptance tests (LLD M02 Tests):
 *   - exactly-once enqueue under concurrent calls
 *   - handler retry and dead letter
 *   - the scheduler does not double-fire with two leaders
 * plus unit tests for cron evaluation, backoff and the rate limiter.
 *
 * The database-backed tests run when TEST_DATABASE_URL points at a disposable Postgres 16
 * with the dbmate migrations applied; otherwise they are skipped.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'kysely';
import { closeDb, initDb, loadConfig, newId, systemDb, type Db, type RedisLike } from '../m01_platform/index.js';
import { backoffMs, BACKOFF_CAP_MS } from './backoff.js';
import { cronMatches, nextFire, parseCron, previousFire } from './cron.js';
import { enqueue, emit, setEventDb, subscribe } from './queue.js';
import { takeToken } from './rate.js';
import { onDeadLetter, registerHandler, resetRegistriesForTesting } from './registry.js';
import { QueueRuntime, syncRegistrations } from './runtime.js';
import { NonRetryable, type DeadLetterInfo, type PayloadSchema } from './types.js';

const anyObject: PayloadSchema<Record<string, unknown>> = {
  safeParse(input: unknown) {
    if (input !== null && typeof input === 'object') return { success: true, data: input as Record<string, unknown> };
    return { success: false, error: { message: 'expected object' } };
  },
};

const counterSchema: PayloadSchema<{ n: number }> = {
  safeParse(input: unknown) {
    const n = (input as { n?: unknown } | null)?.n;
    if (typeof n === 'number') return { success: true, data: { n } };
    return { success: false, error: { message: 'n must be a number' } };
  },
};

describe('cron', () => {
  test('parses fields, names and macros', () => {
    const s = parseCron('*/15 9-17 * JAN-MAR MON-FRI');
    assert.deepEqual([...s.minutes], [0, 15, 30, 45]);
    assert.equal(s.hours.size, 9);
    assert.deepEqual([...s.months], [1, 2, 3]);
    assert.deepEqual([...s.daysOfWeek], [1, 2, 3, 4, 5]);
    assert.deepEqual([...parseCron('@daily').hours], [0]);
    assert.ok(parseCron('0 0 * * 7').daysOfWeek.has(0));
  });

  test('rejects malformed expressions', () => {
    for (const bad of ['* * * *', '60 * * * *', '5-1 * * * *', '*/0 * * * *', 'x * * * *']) {
      assert.throws(() => parseCron(bad), /Invalid cron/);
    }
  });

  test('dom/dow are OR-ed when both are restricted', () => {
    const s = parseCron('0 0 1 * MON');
    assert.ok(cronMatches(s, new Date('2026-09-01T00:00:00Z'))); // Tuesday, 1st
    assert.ok(cronMatches(s, new Date('2026-09-07T00:00:00Z'))); // Monday
    assert.ok(!cronMatches(s, new Date('2026-09-08T00:00:00Z')));
  });

  test('previousFire / nextFire', () => {
    const s = parseCron('30 2 * * *');
    const now = new Date('2026-09-25T10:00:10Z');
    assert.equal(previousFire(s, now, new Date('2026-09-24T00:00:00Z'))?.toISOString(), '2026-09-25T02:30:00.000Z');
    assert.equal(previousFire(s, now, new Date('2026-09-25T02:30:00Z')), null); // strictly after
    assert.equal(nextFire(s, now)?.toISOString(), '2026-09-26T02:30:00.000Z');
    const monthly = parseCron('@monthly');
    assert.equal(previousFire(monthly, now, new Date('2026-01-15T00:00:00Z'))?.toISOString(), '2026-09-01T00:00:00.000Z');
  });
});

describe('backoff', () => {
  test('min(2^attempts × 5 s, 1 h) with ±20% jitter', () => {
    assert.equal(backoffMs(1, 0.5), 10_000);
    assert.equal(backoffMs(3, 0.5), 40_000);
    assert.equal(backoffMs(1, 0), 8_000);
    assert.equal(backoffMs(1, 1), 12_000);
    assert.equal(backoffMs(40, 0.5), BACKOFF_CAP_MS);
    assert.ok(backoffMs(40, 0.999) <= BACKOFF_CAP_MS * 1.2);
  });
});

describe('rate limiter (SET NX fallback)', () => {
  test('grants one token per 1/per_second interval', async () => {
    const store = new Map<string, string>();
    const fake: RedisLike = {
      async get(k) {
        return store.get(k) ?? null;
      },
      async set(k, v, ...args) {
        if (args.includes('NX') && store.has(k)) return null;
        store.set(k, v);
        return 'OK';
      },
      async del(...keys) {
        let n = 0;
        for (const k of keys) if (store.delete(k)) n++;
        return n;
      },
      async quit() {
        return 'OK';
      },
    };
    const rc = { name: 'vendor.x', maxConcurrency: 2, perSecond: 2 };
    assert.equal(await takeToken(fake, rc, 1_000), true);
    assert.equal(await takeToken(fake, rc, 1_100), false);
    assert.equal(await takeToken(fake, rc, 1_500), true);
  });
});

const DB_URL = process.env.TEST_DATABASE_URL;

describe('queue against Postgres', { skip: DB_URL ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  const prefix = `t${Date.now().toString(36)}`;

  before(() => {
    initDb(loadConfig({ APP_ENV: 'test', AWS_REGION: 'ap-south-1' }), { connectionString: DB_URL! });
    db = systemDb('m02 tests');
  });
  after(async () => {
    await sql`delete from platform.job where type like ${prefix + '%'}`.execute(db);
    await sql`delete from platform.schedule where name like ${prefix + '%'}`.execute(db);
    await closeDb();
  });
  beforeEach(() => resetRegistriesForTesting());

  test('exactly-once enqueue under concurrent calls', async () => {
    const type = `${prefix}.once`;
    const ids = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.transaction().execute((tx: Db) => enqueue(tx, { type, queue: 'serving', payload: { n: 1 }, idempotencyKey: 'k1' })),
      ),
    );
    assert.equal(new Set(ids).size, 1);
    const r = await sql`select count(*)::int as n from platform.job where type = ${type}`.execute(db);
    assert.equal((r.rows[0] as { n: number }).n, 1);
  });

  test('handler retry, then dead letter after max_attempts', async () => {
    const type = `${prefix}.flaky`;
    let calls = 0;
    registerHandler(type, counterSchema, async () => {
      calls++;
      throw new Error('boom');
    });
    const dead: DeadLetterInfo[] = [];
    onDeadLetter((i) => {
      dead.push(i);
    });
    const id = await enqueue(db, { type, queue: 'serving', payload: { n: 1 }, idempotencyKey: 'r1', maxAttempts: 2 });
    const rt = new QueueRuntime({ queue: 'serving', leader: false, db, random: () => 0.5 });
    await rt.pollOnce();
    await rt.drain();
    let row = (await sql`select state, attempts, run_at > now() as later from platform.job where id = ${id}`.execute(db)).rows[0] as {
      state: string;
      attempts: number;
      later: boolean;
    };
    assert.deepEqual([row.state, row.attempts, row.later], ['queued', 1, true]);
    await sql`update platform.job set run_at = now() where id = ${id}`.execute(db);
    await rt.pollOnce();
    await rt.drain();
    row = (await sql`select state, attempts from platform.job where id = ${id}`.execute(db)).rows[0] as typeof row;
    assert.equal(row.state, 'dead');
    assert.equal(calls, 2);
    assert.equal(dead.length, 1);
    assert.equal(dead[0]!.reason, 'max_attempts');
  });

  test('NonRetryable and invalid payloads go straight to dead', async () => {
    const t1 = `${prefix}.nonretry`;
    const t2 = `${prefix}.badpayload`;
    registerHandler(t1, counterSchema, async () => {
      throw new NonRetryable('nope');
    });
    registerHandler(t2, counterSchema, async () => undefined);
    const a = await enqueue(db, { type: t1, queue: 'serving', payload: { n: 1 }, idempotencyKey: 'x' });
    const b = await enqueue(db, { type: t2, queue: 'serving', payload: { wrong: true }, idempotencyKey: 'x' });
    const rt = new QueueRuntime({ queue: 'serving', leader: false, db });
    await rt.pollOnce();
    await rt.drain();
    const r = await sql`select id, state, attempts from platform.job where id in (${a}, ${b})`.execute(db);
    for (const row of r.rows as Array<{ state: string; attempts: number }>) {
      assert.equal(row.state, 'dead');
      assert.equal(row.attempts, 1);
    }
  });

  test('scheduler does not double-fire with two leaders', async () => {
    const name = `${prefix}-sched`;
    const now = new Date();
    const r1 = new QueueRuntime({ queue: 'serving', leader: true, db });
    const r2 = new QueueRuntime({ queue: 'serving', leader: true, db });
    await sql`insert into platform.schedule (name, cron, job_type, payload, queue) values (${name}, '* * * * *', ${`${prefix}.tick`}, '{}'::jsonb, 'serving')
              on conflict (name) do nothing`.execute(db);
    const [a, b] = await Promise.all([r1.scheduleOnce(now), r2.scheduleOnce(now)]);
    // Only other schedules in the table could add to the count; ours fired exactly once.
    const r = await sql`select count(*)::int as n from platform.job where type = ${`${prefix}.tick`}`.execute(db);
    assert.equal((r.rows[0] as { n: number }).n, 1);
    assert.ok(a + b >= 1);
    // A second tick in the same minute does not fire again.
    await r1.scheduleOnce(now);
    const r2b = await sql`select count(*)::int as n from platform.job where type = ${`${prefix}.tick`}`.execute(db);
    assert.equal((r2b.rows[0] as { n: number }).n, 1);
  });

  test('outbox → subscriber job, handled once', async () => {
    const evt = `${prefix}.evt`;
    let seen = 0;
    subscribe(evt, 'counter', async () => {
      seen++;
    });
    const rt = new QueueRuntime({ queue: 'serving', leader: true, db });
    await syncRegistrations(db);
    setEventDb(db);
    await db.transaction().execute((tx: Db) => emit(tx, evt, { v: 1, id: newId() }));
    await rt.dispatchOnce();
    await rt.pollOnce();
    await rt.drain();
    assert.equal(seen, 1);
    await sql`delete from platform.subscription where event_type = ${evt}`.execute(db);
    await sql`delete from platform.job where type like ${'evt:' + evt + '%'}`.execute(db);
  });

  test('anyObject schema sanity', () => {
    assert.equal(anyObject.safeParse(1).success, false);
  });
});
