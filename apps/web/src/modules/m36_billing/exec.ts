/**
 * M36 — a uniform way to run raw billing SQL, either tenant-scoped (ctx-bound: RLS session
 * settings + explicit account_id predicates, for request paths) or unscoped (systemDb, for the
 * Razorpay webhook processor and the reconciliation job, which act on an accountId taken from
 * webhook payloads rather than from a request actor). Mirrors M28's exec.ts.
 */
import type { RawBuilder } from 'kysely';
import { AppError, scoped, systemDb, type ActorContext, type Db, type ScopedDb } from '../m01_platform/index.js';

export interface Exec {
  run<R = Record<string, unknown>>(query: RawBuilder<R>): Promise<R[]>;
  transaction<T>(fn: (ex: Exec) => Promise<T>): Promise<T>;
}

class ScopedExec implements Exec {
  private readonly db: ScopedDb;

  constructor(db: ScopedDb) {
    // Assigned explicitly (rather than via a constructor parameter property) so the class has a
    // real constructor body: this instance is bound to one tenant-scoped Kysely connection for
    // the lifetime of the request, and every run()/transaction() call below reads it back.
    this.db = db;
  }

  run<R = Record<string, unknown>>(query: RawBuilder<R>): Promise<R[]> {
    return this.db.raw(query);
  }

  transaction<T>(fn: (ex: Exec) => Promise<T>): Promise<T> {
    return this.db.transaction((trx: ScopedDb) => fn(new ScopedExec(trx)));
  }
}

class SystemExec implements Exec {
  private readonly db: Db;

  constructor(db: Db) {
    // See ScopedExec's constructor: the unscoped (RLS-bypassing) db handle used by the webhook
    // processor and the reconciliation job is stored the same explicit way.
    this.db = db;
  }

  async run<R = Record<string, unknown>>(query: RawBuilder<R>): Promise<R[]> {
    const res = await query.execute(this.db);
    return res.rows;
  }

  transaction<T>(fn: (ex: Exec) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx: Db) => fn(new SystemExec(trx))) as Promise<T>;
  }
}

/** For request paths: requires a signed-in member (ctx.accountId set). */
export function userExec(ctx: ActorContext): { exec: Exec; accountId: string } {
  if (!ctx.accountId) throw new AppError('UNAUTHENTICATED', 'Sign in required');
  return { exec: new ScopedExec(scoped(ctx)), accountId: ctx.accountId };
}

/** For system/background paths (the webhook processor, the reconciliation job). `reason` is
 * logged by systemDb(). */
export function systemExec(reason: string, ctx?: ActorContext): Exec {
  return new SystemExec(systemDb(`m36: ${reason}`, ctx));
}
