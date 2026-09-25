/**
 * M01 acceptance tests (LLD M01 Tests):
 *   - A scoped query can never return rows from another account (property test, 2 accounts).
 *   - A missing ctx throws.
 *
 * Run: node --test (after build). The database-backed property test runs when
 * TEST_DATABASE_URL points at a disposable Postgres 16; the connecting role must NOT be a
 * superuser or table owner for the RLS half of the assertion to be meaningful.
 */
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { DummyDriver, sql } from 'kysely';
import { AppError } from './errors.js';
import { loadConfig } from './config.js';
import { closeDb, initDb, scoped, systemDb } from './db.js';
import { newId } from './ids.js';
import { classifyBudget } from './budget.js';
import { clearTenantRegistryForTesting, registerTenantTable } from './tenancy.js';
import type { ActorContext, Id } from './types.js';

function ctxFor(accountId?: string, workspaceId?: string, kind: ActorContext['kind'] = 'user'): ActorContext {
  const c: ActorContext = {
    kind,
    entitlements: {
      plan: 'free',
      searchResultCap: 10,
      exportRowsPerMonth: 0,
      bulkRevealMax: 0,
      checksPerMonth: 0,
      revealsIncludedPerMonth: 0,
    },
    locale: 'en',
    region: 'IN',
    mfaVerified: false,
    correlationId: newId<'corr'>(),
  };
  if (accountId) c.accountId = accountId as Id<'account'>;
  if (workspaceId) c.workspaceId = workspaceId as Id<'workspace'>;
  return c;
}

function assertAppError(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === code);
}

describe('scoped() — query construction', () => {
  before(() => {
    clearTenantRegistryForTesting();
    registerTenantTable('serving.m01_probe_acct', 'account');
    registerTenantTable('serving.m01_probe_ws', 'workspace');
    registerTenantTable('serving.m01_probe_global', 'global');
    initDb(loadConfig({ APP_ENV: 'test', AWS_REGION: 'ap-south-1' }), { driver: new DummyDriver() });
  });
  after(async () => {
    await closeDb();
  });

  test('missing ctx throws FORBIDDEN', () => {
    assertAppError(() => scoped(undefined as unknown as ActorContext), 'FORBIDDEN');
    assertAppError(() => scoped(null as unknown as ActorContext), 'FORBIDDEN');
  });

  test('ctx without accountId cannot touch tenant tables', () => {
    const db = scoped(ctxFor());
    assertAppError(() => db.selectFrom('serving.m01_probe_acct'), 'FORBIDDEN');
    assertAppError(() => db.insertInto('serving.m01_probe_acct', { v: 1 }), 'FORBIDDEN');
    // global tables are fine
    assert.doesNotThrow(() => db.selectFrom('serving.m01_probe_global'));
  });

  test('workspace table without workspaceId throws', () => {
    const db = scoped(ctxFor(newId()));
    assertAppError(() => db.selectFrom('serving.m01_probe_ws'), 'FORBIDDEN');
  });

  test('unregistered table fails closed', () => {
    const db = scoped(ctxFor(newId()));
    assertAppError(() => db.selectFrom('serving.not_registered'), 'INTERNAL');
  });

  test('malformed ids are refused', () => {
    assertAppError(() => scoped(ctxFor('not-a-uuid')), 'FORBIDDEN');
  });

  test('property: every compiled query is bound to the actor account (200 random actors)', () => {
    for (let i = 0; i < 200; i++) {
      const acct = newId<'account'>();
      const ws = newId<'workspace'>();
      const db = scoped(ctxFor(acct, ws));
      const useWs = randomInt(2) === 1;
      const table = useWs ? 'serving.m01_probe_ws' : 'serving.m01_probe_acct';

      const sel = db.selectFrom(`${table} as t`).selectAll().compile();
      assert.match(sel.sql, /"t"\."account_id" = \$1/);
      assert.equal(sel.parameters[0], acct);
      if (useWs) {
        assert.match(sel.sql, /"t"\."workspace_id" = \$2/);
        assert.equal(sel.parameters[1], ws);
      }

      const ins = db.insertInto(table, { v: i }).compile();
      assert.ok((ins.parameters as unknown[]).includes(acct));

      const upd = db.updateTable(table, { v: i + 1 }).compile();
      assert.ok((upd.parameters as unknown[]).includes(acct));

      const del = db.deleteFrom(table).compile();
      assert.ok((del.parameters as unknown[]).includes(acct));
    }
  });

  test('rows carrying another tenant id are refused', () => {
    const db = scoped(ctxFor(newId(), newId()));
    assertAppError(() => db.insertInto('serving.m01_probe_acct', { v: 1, account_id: newId() }), 'FORBIDDEN');
    assertAppError(() => db.insertInto('serving.m01_probe_ws', { v: 1, workspace_id: newId() }), 'FORBIDDEN');
    assertAppError(() => db.updateTable('serving.m01_probe_acct', { account_id: newId() }), 'FORBIDDEN');
  });

  test('systemDb refuses user actors and requires a reason', () => {
    assertAppError(() => systemDb('reporting', ctxFor(newId())), 'FORBIDDEN');
    assertAppError(() => systemDb(''), 'VALIDATION');
    assert.doesNotThrow(() => systemDb('nightly job', ctxFor(undefined, undefined, 'system')));
  });
});

describe('classifyBudget', () => {
  test('levels', () => {
    assert.equal(classifyBudget(0n, null, 80).level, 'ok');
    assert.equal(classifyBudget(79n, 100n, 80).level, 'ok');
    assert.equal(classifyBudget(80n, 100n, 80).level, 'alert');
    assert.equal(classifyBudget(100n, 100n, 80).level, 'exceeded');
    assert.equal(classifyBudget(150n, 100n, 80).pctUsed, 150);
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;

describe('scoped() — database property test (2 accounts)', { skip: TEST_DB ? false : 'TEST_DATABASE_URL not set' }, () => {
  const accountA = newId<'account'>();
  const accountB = newId<'account'>();

  before(async () => {
    clearTenantRegistryForTesting();
    registerTenantTable('serving.m01_probe', 'account');
    await closeDb();
    initDb(loadConfig({ APP_ENV: 'test', AWS_REGION: 'ap-south-1' }), { connectionString: TEST_DB! });
    const sys = systemDb('m01 test setup');
    await sql`drop table if exists serving.m01_probe`.execute(sys);
    await sql`create table serving.m01_probe (id uuid primary key, account_id uuid not null, v int not null,
              created_at timestamptz not null default now())`.execute(sys);
    await sql`select platform.enable_tenant_rls('serving.m01_probe'::regclass, false)`.execute(sys);
  });

  after(async () => {
    try {
      await sql`drop table if exists serving.m01_probe`.execute(systemDb('m01 test teardown'));
    } finally {
      await closeDb();
    }
  });

  test('random interleaved writes: each account only ever sees its own rows', async () => {
    const dbA = scoped(ctxFor(accountA));
    const dbB = scoped(ctxFor(accountB));
    const expected = { a: 0, b: 0 };
    for (let i = 0; i < 100; i++) {
      const toA = randomInt(2) === 0;
      await (toA ? dbA : dbB).insertInto('serving.m01_probe', { id: newId(), v: i }).execute();
      if (toA) expected.a++;
      else expected.b++;

      const rowsA = (await dbA.selectFrom('serving.m01_probe').selectAll().execute()) as Array<{ account_id: string }>;
      const rowsB = (await dbB.selectFrom('serving.m01_probe').selectAll().execute()) as Array<{ account_id: string }>;
      assert.equal(rowsA.length, expected.a);
      assert.equal(rowsB.length, expected.b);
      assert.ok(rowsA.every((r) => r.account_id === accountA));
      assert.ok(rowsB.every((r) => r.account_id === accountB));
    }
    // RLS backstop: a raw query with no predicate still only sees own rows.
    const rawA = await dbA.raw<{ account_id: string }>(sql`select account_id from serving.m01_probe`);
    assert.ok(rawA.every((r) => r.account_id === accountA));
    // Cross-tenant delete affects nothing.
    await dbA.deleteFrom('serving.m01_probe').execute();
    const leftB = (await dbB.selectFrom('serving.m01_probe').selectAll().execute()) as unknown[];
    assert.equal(leftB.length, expected.b);
  });
});
