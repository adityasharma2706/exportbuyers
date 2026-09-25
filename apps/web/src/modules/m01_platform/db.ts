/**
 * M01 — database access (IF-01a ScopedDataAccess).
 *
 *   scoped(ctx)        tenant-scoped Kysely wrapper: adds WHERE account_id (and workspace_id)
 *                      to every query on a registered tenant table, injects the ids on insert.
 *   systemDb(reason)   unscoped access for kind='system'|'admin' only; the reason is logged.
 *
 * Defence in depth: Postgres RLS sits underneath. Every pooled connection handed out by the
 * drivers below carries the actor's tenant ids as session settings (`app.account_id`,
 * `app.workspace_id`, `app.rls_bypass`); inside a transaction they are applied again with
 * SET LOCAL semantics (`set_config(..., true)`). All three settings are overwritten on every
 * acquire, so a pooled connection can never leak a previous actor's ids.
 *
 * NOTE: session settings require session-level pooling. Do not put PgBouncer in
 * transaction-pooling mode in front of app_serving without moving to SET LOCAL-only access.
 */
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresDriver,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Driver,
  type TransactionSettings,
} from 'kysely';
import pg from 'pg';
import type { PlatformConfig } from './config.js';
import { isIndiaRegion } from './config.js';
import { AppError } from './errors.js';
import { isUuid } from './ids.js';
import { log } from './logging.js';
import { getSecret } from './secrets.js';
import { parseTableRef, tenantScopeOf, type Row, type TenantScope, type TenantTable } from './tenancy.js';
import type { ActorContext } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = Kysely<any>;

interface SessionSettings {
  accountId: string;
  workspaceId: string;
  rlsBypass: 'on' | 'off';
}

const APPLY_SETTINGS_SQL =
  "select set_config('app.account_id', $1, $4), set_config('app.workspace_id', $2, $4), set_config('app.rls_bypass', $3, $4)";

async function applySettings(conn: DatabaseConnection, s: SessionSettings, local: boolean): Promise<void> {
  await conn.executeQuery(CompiledQuery.raw(APPLY_SETTINGS_SQL, [s.accountId, s.workspaceId, s.rlsBypass, local]));
}

const CLEARED: SessionSettings = { accountId: '', workspaceId: '', rlsBypass: 'off' };

/**
 * Wraps the shared base driver so every connection is stamped with one actor's settings.
 * Many of these share one pool; destroy() is therefore a no-op — the pool is owned by
 * initDb()/closeDb().
 */
class SessionSettingsDriver implements Driver {
  constructor(
    private readonly inner: Driver,
    private readonly ensureInit: () => Promise<void>,
    private readonly settings: SessionSettings,
  ) {}

  async init(): Promise<void> {
    await this.ensureInit();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const conn = await this.inner.acquireConnection();
    try {
      await applySettings(conn, this.settings, false);
    } catch (e) {
      await this.inner.releaseConnection(conn);
      throw e;
    }
    return conn;
  }

  async beginTransaction(conn: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    await this.inner.beginTransaction(conn, settings);
    // SET LOCAL semantics for the transaction (LLD M01: "applied per transaction with SET LOCAL").
    await applySettings(conn, this.settings, true);
  }

  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await this.inner.commitTransaction(conn);
  }

  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await this.inner.rollbackTransaction(conn);
  }

  async releaseConnection(conn: DatabaseConnection): Promise<void> {
    try {
      await applySettings(conn, CLEARED, false);
    } catch (err) {
      // Safe to continue: the next acquire overwrites all settings before any query runs.
      log.warn({ err }, 'failed to clear tenant session settings on release');
    } finally {
      await this.inner.releaseConnection(conn);
    }
  }

  async destroy(): Promise<void> {
    /* shared pool is destroyed by closeDb() */
  }
}

// ---------------------------------------------------------------------------------------
// Base pool / driver
// ---------------------------------------------------------------------------------------

let baseDriver: Driver | undefined;
let basePool: { end(): Promise<void> } | undefined;
let initPromise: Promise<void> | undefined;
let systemKysely: Db | undefined;

function ensureInit(): Promise<void> {
  if (!baseDriver) return Promise.reject(new AppError('INTERNAL', 'Database not initialised; call initDb() at boot'));
  if (initPromise) return initPromise;
  const d = baseDriver;
  const p: Promise<void> = d.init().catch((e: unknown) => {
    initPromise = undefined;
    throw e;
  });
  initPromise = p;
  return p;
}

function kyselyWith(settings: SessionSettings): Db {
  if (!baseDriver) throw new AppError('INTERNAL', 'Database not initialised; call initDb() at boot');
  const inner = baseDriver;
  return new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new SessionSettingsDriver(inner, ensureInit, settings),
      createIntrospector: (db: Db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }) as Db;
}

/**
 * Refuses database hosts that are identifiably outside India (AWS RDS / Aurora hostnames
 * embed the region). Unknown host patterns (e.g. localhost in dev) are allowed.
 */
export function assertDbHostInIndia(connectionString: string): void {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new AppError('INTERNAL', 'DATABASE_URL is not a valid URL');
  }
  const m = /\.([a-z]{2}-[a-z]+-\d)\.rds\.amazonaws\.com$/i.exec(host);
  if (m && !isIndiaRegion(m[1]!)) {
    throw new AppError('INTERNAL', `Database host is in ${m[1]}, outside India`, { region: m[1] });
  }
}

export interface InitDbOptions {
  /** Defaults to the DATABASE_URL secret. */
  connectionString?: string;
  /** Test hook: supply a driver (e.g. Kysely's DummyDriver) instead of a pg pool. */
  driver?: Driver;
}

export function initDb(cfg: PlatformConfig, opts: InitDbOptions = {}): void {
  if (baseDriver) return;
  if (opts.driver) {
    baseDriver = opts.driver;
    return;
  }
  const connectionString = opts.connectionString ?? getSecret('DATABASE_URL');
  assertDbHostInIndia(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max: cfg.db.poolMax,
    application_name: cfg.serviceName,
    statement_timeout: cfg.db.statementTimeoutMs,
    ssl: cfg.appEnv === 'local' || cfg.appEnv === 'test' ? undefined : { rejectUnauthorized: true },
  });
  pool.on('error', (err: Error) => log.error({ err }, 'idle postgres client error'));
  basePool = pool;
  baseDriver = new PostgresDriver({ pool });
}

export async function closeDb(): Promise<void> {
  const d = baseDriver;
  baseDriver = undefined;
  initPromise = undefined;
  systemKysely = undefined;
  if (d) await d.destroy();
  else if (basePool) await basePool.end();
  basePool = undefined;
}

// ---------------------------------------------------------------------------------------
// systemDb
// ---------------------------------------------------------------------------------------

/**
 * Unscoped database access. Allowed for kind='system'|'admin' only. The reason is logged
 * on every call so unscoped access is auditable.
 *
 * `ctx` is optional because background jobs have no request actor; when a ctx is passed
 * (request paths), anything other than system/admin is refused with FORBIDDEN.
 */
export function systemDb(reason: string, ctx?: ActorContext): Db {
  if (typeof reason !== 'string' || reason.trim().length < 3) {
    throw new AppError('VALIDATION', 'systemDb() requires a descriptive reason');
  }
  if (ctx && ctx.kind !== 'system' && ctx.kind !== 'admin') {
    throw new AppError('FORBIDDEN', 'Unscoped database access is only allowed for system or admin actors', {
      actorKind: ctx.kind,
    });
  }
  log.info(
    { reason, actorKind: ctx?.kind ?? 'system', memberId: ctx?.memberId, correlationId: ctx?.correlationId },
    'systemDb access',
  );
  if (!systemKysely) systemKysely = kyselyWith({ accountId: '', workspaceId: '', rlsBypass: 'on' });
  return systemKysely;
}

// ---------------------------------------------------------------------------------------
// scoped()
// ---------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBuilder = any;

export interface ScopedDb {
  readonly ctx: ActorContext;
  /** Adds WHERE <alias>.account_id = ctx.accountId (and workspace_id for workspace tables). */
  selectFrom<T extends TenantTable>(t: T): AnyBuilder;
  /** Injects account_id / workspace_id. Rows that carry different ids are refused. */
  insertInto<T extends TenantTable>(
    t: T,
    row: Omit<Row<T>, 'account_id' | 'workspace_id'> | ReadonlyArray<Omit<Row<T>, 'account_id' | 'workspace_id'>>,
  ): AnyBuilder;
  /** Update restricted to the actor's tenant rows. Tenant columns may not be changed. */
  updateTable<T extends TenantTable>(t: T, set: Partial<Omit<Row<T>, 'account_id' | 'workspace_id'>>): AnyBuilder;
  /** Delete restricted to the actor's tenant rows. */
  deleteFrom<T extends TenantTable>(t: T): AnyBuilder;
  /**
   * Executes a raw `sql` template (Kysely RawBuilder) under this actor's RLS settings.
   * No predicate is injected here — RLS is the only guard — so prefer the builders above.
   */
  raw<R = Record<string, unknown>>(query: { execute(db: Db): Promise<{ rows: R[] }> }): Promise<R[]>;
  transaction<R>(fn: (db: ScopedDb) => Promise<R>): Promise<R>;
}

const TENANT_COLUMNS = ['account_id', 'workspace_id'] as const;

class ScopedDbImpl implements ScopedDb {
  constructor(
    readonly ctx: ActorContext,
    private readonly db: Db,
    private readonly inTransaction: boolean,
  ) {}

  private scopeFor(tableRef: string): { alias: string; table: string; scope: TenantScope } {
    const { table, alias } = parseTableRef(tableRef);
    const scope = tenantScopeOf(table);
    if (scope !== 'global' && !this.ctx.accountId) {
      throw new AppError('FORBIDDEN', `Table ${table} is account-scoped but the actor has no accountId`, { table });
    }
    if (scope === 'workspace' && !this.ctx.workspaceId) {
      throw new AppError('FORBIDDEN', `Table ${table} is workspace-scoped but the actor has no workspaceId`, { table });
    }
    return { alias, table, scope };
  }

  private addPredicates(qb: AnyBuilder, alias: string, scope: TenantScope): AnyBuilder {
    if (scope === 'global') return qb;
    let out = qb.where(`${alias}.account_id`, '=', this.ctx.accountId);
    if (scope === 'workspace') out = out.where(`${alias}.workspace_id`, '=', this.ctx.workspaceId);
    return out;
  }

  selectFrom<T extends TenantTable>(t: T): AnyBuilder {
    const { alias, scope } = this.scopeFor(t);
    return this.addPredicates(this.db.selectFrom(t), alias, scope);
  }

  insertInto<T extends TenantTable>(
    t: T,
    row: Omit<Row<T>, 'account_id' | 'workspace_id'> | ReadonlyArray<Omit<Row<T>, 'account_id' | 'workspace_id'>>,
  ): AnyBuilder {
    const { table, scope } = this.scopeFor(t);
    const rows = (Array.isArray(row) ? row : [row]) as ReadonlyArray<Record<string, unknown>>;
    if (rows.length === 0) throw new AppError('VALIDATION', `insertInto(${table}) called with no rows`);
    const stamped = rows.map((r) => this.stampRow(table, scope, r));
    return this.db.insertInto(table).values(stamped);
  }

  private stampRow(table: string, scope: TenantScope, r: Record<string, unknown>): Record<string, unknown> {
    if (scope === 'global') return { ...r };
    const out: Record<string, unknown> = { ...r };
    const supplied = out.account_id;
    if (supplied !== undefined && supplied !== this.ctx.accountId) {
      throw new AppError('FORBIDDEN', `Row for ${table} carries a different account_id`, { table });
    }
    out.account_id = this.ctx.accountId;
    if (scope === 'workspace') {
      const ws = out.workspace_id;
      if (ws !== undefined && ws !== this.ctx.workspaceId) {
        throw new AppError('FORBIDDEN', `Row for ${table} carries a different workspace_id`, { table });
      }
      out.workspace_id = this.ctx.workspaceId;
    }
    return out;
  }

  updateTable<T extends TenantTable>(t: T, set: Partial<Omit<Row<T>, 'account_id' | 'workspace_id'>>): AnyBuilder {
    const { alias, table, scope } = this.scopeFor(t);
    const values = set as Record<string, unknown>;
    for (const c of TENANT_COLUMNS) {
      if (c in values) throw new AppError('FORBIDDEN', `Cannot change ${c} on ${table}`, { table });
    }
    if (Object.keys(values).length === 0) throw new AppError('VALIDATION', `updateTable(${table}) called with nothing to set`);
    return this.addPredicates(this.db.updateTable(t).set(values), alias, scope);
  }

  deleteFrom<T extends TenantTable>(t: T): AnyBuilder {
    const { alias, scope } = this.scopeFor(t);
    return this.addPredicates(this.db.deleteFrom(t), alias, scope);
  }

  async raw<R = Record<string, unknown>>(query: { execute(db: Db): Promise<{ rows: R[] }> }): Promise<R[]> {
    const res = await query.execute(this.db);
    return res.rows;
  }

  async transaction<R>(fn: (db: ScopedDb) => Promise<R>): Promise<R> {
    if (this.inTransaction) return fn(this); // nested: join the outer transaction
    return this.db
      .transaction()
      .execute((trx: Db) => fn(new ScopedDbImpl(this.ctx, trx, true))) as Promise<R>;
  }
}

function validateCtx(ctx: ActorContext | null | undefined): ActorContext {
  if (!ctx || typeof ctx !== 'object') {
    throw new AppError('FORBIDDEN', 'Missing actor context');
  }
  if (ctx.accountId !== undefined && !isUuid(ctx.accountId)) {
    throw new AppError('FORBIDDEN', 'Actor context has a malformed accountId');
  }
  if (ctx.workspaceId !== undefined && !isUuid(ctx.workspaceId)) {
    throw new AppError('FORBIDDEN', 'Actor context has a malformed workspaceId');
  }
  if (ctx.workspaceId !== undefined && ctx.accountId === undefined) {
    throw new AppError('FORBIDDEN', 'Actor context has a workspaceId without an accountId');
  }
  return ctx;
}

/** IF-01a. Throws FORBIDDEN when ctx is missing or malformed. */
export function scoped(ctx: ActorContext): ScopedDb {
  const c = validateCtx(ctx);
  const db = kyselyWith({ accountId: c.accountId ?? '', workspaceId: c.workspaceId ?? '', rlsBypass: 'off' });
  return new ScopedDbImpl(c, db, false);
}
