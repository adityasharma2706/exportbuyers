/**
 * M29 — reads `knowledge.v_contact_value` under the `app_reveal` Postgres role (LLD M09 migration:
 * "Contact values are readable only through v_contact_value, granted to app_reveal (M29's
 * repository)."). This is the only file in the codebase allowed to read raw contact values.
 *
 * [deviation: M01's `scoped()`/`systemDb()` (db.ts) share one pool connected as a single
 * application role (`app_serving`), which does not have `select` on `v_contact_value` at all
 * (M09's migration explicitly revokes it). M01 has no mechanism for a second role's pool, and
 * this module must not be granted broader knowledge-plane access than one read-only view, so this
 * file opens its own small dedicated pg.Pool under a separate secret instead of going through M01.
 * `M29_REVEAL_DATABASE_URL` is expected to be a connection string whose role is `app_reveal`; in
 * `local`/`test` it falls back to `DATABASE_URL` (getSecret()'s existing dev fallback), matching
 * how a single local Postgres user typically holds every role's grants in development.]
 */
import pg from 'pg';
import { AppError, assertDbHostInIndia, getConfig, getSecret, hasSecret, log } from '../m01_platform/index.js';

const SECRET_REVEAL_DB_URL = 'M29_REVEAL_DATABASE_URL';

export interface ContactValueRow {
  assertionId: string;
  companyId: string;
  kind: string;
  value: string;
}

let pool: pg.Pool | undefined;

function connectionString(): string {
  return hasSecret(SECRET_REVEAL_DB_URL) ? getSecret(SECRET_REVEAL_DB_URL) : getSecret('DATABASE_URL');
}

function getPool(): pg.Pool {
  if (pool) return pool;
  const cs = connectionString();
  assertDbHostInIndia(cs);
  const appEnv = getConfig().appEnv;
  const p = new pg.Pool({
    connectionString: cs,
    max: 5,
    application_name: 'exportbuyers-m29-reveal',
    ssl: appEnv === 'local' || appEnv === 'test' ? undefined : { rejectUnauthorized: true },
  });
  p.on('error', (err: Error) => log.error({ err }, 'm29: idle app_reveal postgres client error'));
  pool = p;
  return p;
}

/** For tests and graceful shutdown. */
export async function closeContactValuePool(): Promise<void> {
  const p = pool;
  pool = undefined;
  if (p) await p.end();
}

/** Test hook: force a fresh pool on next use (e.g. after configuring a different secret). */
export function resetContactValuePoolForTesting(): void {
  pool = undefined;
}

const MAX_IDS = 2000;

/**
 * Reads `knowledge.v_contact_value` for the given assertion ids. Returns a map keyed by
 * assertionId; ids with no row (deleted, never enriched) are simply absent.
 */
export async function fetchContactValues(assertionIds: readonly string[]): Promise<Map<string, ContactValueRow>> {
  const out = new Map<string, ContactValueRow>();
  if (assertionIds.length === 0) return out;
  if (assertionIds.length > MAX_IDS) throw new AppError('VALIDATION', `At most ${MAX_IDS} assertion ids per lookup`);
  const p = getPool();
  const res = await p.query<{ assertion_id: string; company_id: string; kind: string; value: string }>(
    'select assertion_id, company_id, kind, value from knowledge.v_contact_value where assertion_id = any($1::uuid[])',
    [assertionIds],
  );
  for (const r of res.rows) {
    out.set(String(r.assertion_id), {
      assertionId: String(r.assertion_id),
      companyId: String(r.company_id),
      kind: String(r.kind),
      value: String(r.value),
    });
  }
  return out;
}
