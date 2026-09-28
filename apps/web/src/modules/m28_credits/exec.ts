/**
 * M28 — a uniform way to run raw ledger SQL, either tenant-scoped (ctx-bound: RLS session
 * settings + explicit account_id predicates) or unscoped (systemDb, for grant() and background
 * jobs that touch an accountId chosen by the caller rather than the request actor).
 *
 * The ledger schema (account_balance_acct, entry, balance_cache, allowance_usage) is accessed
 * only through raw SQL here rather than through scoped()'s typed builders: every write needs
 * exact control over locking (`for update`), ON CONFLICT clauses and multi-row double-entry
 * inserts inside one transaction, which the generic ScopedDb builders do not expose. RLS still
 * applies underneath (defence in depth), because ScopedDb.raw()/systemDb() still carry the
 * account/workspace/rls_bypass session settings described in M01.
 */
import type { RawBuilder } from 'kysely';
import { AppError, scoped, systemDb, type ActorContext, type Db, type ScopedDb } from '../m01_platform/index.js';

export interface Exec {
  run<R = Record<string, unknown>>(query: RawBuilder<R>): Promise<R[]>;
  transaction<T>(fn: (ex: Exec) => Promise<T>): Promise<T>;
}

class ScopedExec implements Exec {
  constructor(private readonly db: ScopedDb) {}

  run<R = Record<string, unknown>>(query: RawBuilder<R>): Promise<R[]> {
    return this.db.raw(query);
  }

  transaction<T>(fn: (ex: Exec) => Promise<T>): Promise<T> {
    return this.db.transaction((trx: ScopedDb) => fn(new ScopedExec(trx)));
  }
}

class SystemExec implements Exec {
  constructor(private readonly db: Db) {}

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

/** For system/background paths (grant(), the sweeper, the monthly free grant). `reason` is logged
 * by systemDb(). */
export function systemExec(reason: string, ctx?: ActorContext): Exec {
  return new SystemExec(systemDb(`m28: ${reason}`, ctx));
}
