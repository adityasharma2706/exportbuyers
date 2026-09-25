/**
 * M07 — persistence for serving.business_profile, serving.workspace and
 * serving.tenancy_idempotency. Request paths go through scoped(ctx) (account-scoped tenant
 * tables); only the purge job and data-rights hooks use systemDb() with a logged reason.
 */
import { sql } from 'kysely';
import { registerTenantTable, systemDb, type Db, type Id, type ScopedDb } from '../m01_platform/index.js';
import type { BusinessProfile, ExportExperience, HsLevel, Workspace } from './types.js';

registerTenantTable('serving.business_profile', 'account');
registerTenantTable('serving.workspace', 'account');
registerTenantTable('serving.tenancy_idempotency', 'account');

export interface BusinessProfileRow {
  account_id: string;
  business_name: string;
  city: string | null;
  state: string | null;
  what_they_make: string | null;
  export_experience: ExportExperience | null;
  iec: string | null;
  iec_verified_at: Date | null;
  target_markets: string[];
  sender_name: string | null;
  sender_email: string | null;
  website: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceRow {
  id: string;
  account_id: string;
  name: string;
  hs_code: string | null;
  hs_level: HsLevel | null;
  hs_version: string | null;
  hs_needs_reconfirm: boolean;
  countries: string[];
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TenancyIdempotencyRow {
  account_id: string;
  idem_key: string;
  route: string;
  request_hash: string;
  status: number;
  response: unknown;
  created_at: Date;
}

declare module '../m01_platform/tenancy.js' {
  interface TenantTableRows {
    'serving.business_profile': BusinessProfileRow;
    'serving.workspace': WorkspaceRow;
    'serving.tenancy_idempotency': TenancyIdempotencyRow;
  }
}

// ---- mapping ------------------------------------------------------------------------------

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toDateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : toDate(v);
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** pg returns text[] as a JS array; tolerate the raw '{A,B}' literal too. */
export function textArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    const inner = v.replace(/^\{|\}$/g, '');
    return inner.length === 0 ? [] : inner.split(',').map((s) => s.replace(/^"|"$/g, ''));
  }
  return [];
}

export function mapProfile(r: Record<string, unknown>): BusinessProfile {
  return {
    accountId: String(r.account_id) as Id<'account'>,
    businessName: String(r.business_name),
    city: strOrNull(r.city),
    state: strOrNull(r.state),
    whatTheyMake: strOrNull(r.what_they_make),
    exportExperience: (strOrNull(r.export_experience) as ExportExperience | null) ?? null,
    iec: strOrNull(r.iec),
    iecVerifiedAt: toDateOrNull(r.iec_verified_at),
    targetMarkets: textArray(r.target_markets),
    senderName: strOrNull(r.sender_name),
    senderEmail: strOrNull(r.sender_email),
    website: strOrNull(r.website),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

export function mapWorkspace(r: Record<string, unknown>): Workspace {
  const code = strOrNull(r.hs_code);
  const level = strOrNull(r.hs_level) as HsLevel | null;
  const version = strOrNull(r.hs_version);
  return {
    id: String(r.id) as Id<'workspace'>,
    accountId: String(r.account_id) as Id<'account'>,
    name: String(r.name),
    hs: code !== null && level !== null && version !== null ? { code, level, version } : null,
    hsNeedsReconfirm: r.hs_needs_reconfirm === true,
    countries: textArray(r.countries),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; constraint?: unknown };
  if (err.code !== '23505') return false;
  return constraint === undefined || err.constraint === constraint;
}

export const WORKSPACE_NAME_UNIQUE = 'workspace_account_name_live_uq';

// ---- business profile ----------------------------------------------------------------------

export async function findProfile(db: ScopedDb): Promise<BusinessProfile | undefined> {
  const r = (await db.selectFrom('serving.business_profile').selectAll().executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapProfile(r) : undefined;
}

export async function insertProfile(db: ScopedDb, row: Omit<BusinessProfileRow, 'account_id'>): Promise<boolean> {
  const res = (await db
    .insertInto('serving.business_profile', row)
    .onConflict((oc: { column(c: string): { doNothing(): unknown } }) => oc.column('account_id').doNothing())
    .executeTakeFirst()) as { numInsertedOrUpdatedRows?: bigint } | undefined;
  return Number(res?.numInsertedOrUpdatedRows ?? 0) === 1;
}

export async function updateProfile(db: ScopedDb, set: Partial<Omit<BusinessProfileRow, 'account_id'>>): Promise<BusinessProfile | undefined> {
  const r = (await db.updateTable('serving.business_profile', set).returningAll().executeTakeFirst()) as
    | Record<string, unknown>
    | undefined;
  return r ? mapProfile(r) : undefined;
}

// ---- workspaces ----------------------------------------------------------------------------

/** Serialises workspace creation per account for the rest of the transaction (count limit). */
export async function lockAccountWorkspaces(db: ScopedDb, accountId: string): Promise<void> {
  await db.raw(sql`select pg_advisory_xact_lock(hashtext(${`m07:workspaces:${accountId}`}))`);
}

export async function countLiveWorkspaces(db: ScopedDb): Promise<number> {
  const r = (await db
    .selectFrom('serving.workspace')
    .select((eb: { fn: { countAll(): { as(a: string): unknown } } }) => eb.fn.countAll().as('n'))
    .where('deleted_at', 'is', null)
    .executeTakeFirst()) as { n?: number | string | bigint } | undefined;
  return Number(r?.n ?? 0);
}

export async function listLiveWorkspaces(db: ScopedDb): Promise<Workspace[]> {
  const rows = (await db
    .selectFrom('serving.workspace')
    .selectAll()
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute()) as Array<Record<string, unknown>>;
  return rows.map(mapWorkspace);
}

export async function findLiveWorkspace(db: ScopedDb, id: string, forUpdate = false): Promise<Workspace | undefined> {
  let q = db.selectFrom('serving.workspace').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
  if (forUpdate) q = q.forUpdate();
  const r = (await q.executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapWorkspace(r) : undefined;
}

export async function insertWorkspace(db: ScopedDb, row: Omit<WorkspaceRow, 'account_id'>): Promise<Workspace> {
  const r = (await db.insertInto('serving.workspace', row).returningAll().executeTakeFirstOrThrow()) as Record<string, unknown>;
  return mapWorkspace(r);
}

export async function updateLiveWorkspace(
  db: ScopedDb,
  id: string,
  set: Partial<Omit<WorkspaceRow, 'account_id' | 'id' | 'created_at'>>,
): Promise<Workspace | undefined> {
  const r = (await db
    .updateTable('serving.workspace', set)
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapWorkspace(r) : undefined;
}

// ---- idempotency ---------------------------------------------------------------------------

export async function findIdempotent(db: ScopedDb, key: string): Promise<TenancyIdempotencyRow | undefined> {
  const r = (await db.selectFrom('serving.tenancy_idempotency').selectAll().where('idem_key', '=', key).executeTakeFirst()) as
    | Record<string, unknown>
    | undefined;
  if (!r) return undefined;
  return {
    account_id: String(r.account_id),
    idem_key: String(r.idem_key),
    route: String(r.route),
    request_hash: String(r.request_hash),
    status: Number(r.status),
    response: typeof r.response === 'string' ? (JSON.parse(r.response) as unknown) : (r.response ?? null),
    created_at: toDate(r.created_at),
  };
}

/** Returns false when another request stored the same key first. */
export async function storeIdempotent(
  db: ScopedDb,
  row: { idem_key: string; route: string; request_hash: string; status: number; response: unknown },
): Promise<boolean> {
  const res = (await db
    .insertInto('serving.tenancy_idempotency', {
      idem_key: row.idem_key,
      route: row.route,
      request_hash: row.request_hash,
      status: row.status,
      response: row.response === undefined ? null : JSON.stringify(row.response),
      created_at: new Date(),
    })
    .onConflict((oc: { columns(c: string[]): { doNothing(): unknown } }) => oc.columns(['account_id', 'idem_key']).doNothing())
    .executeTakeFirst()) as { numInsertedOrUpdatedRows?: bigint } | undefined;
  return Number(res?.numInsertedOrUpdatedRows ?? 0) === 1;
}

// ---- system paths (purge job, data rights) ---------------------------------------------------

const sys = (reason: string): Db => systemDb(`m07: ${reason}`);

export async function purgeDeletedWorkspaces(before: Date): Promise<string[]> {
  const rows = (await sys('purge soft-deleted workspaces')
    .deleteFrom('serving.workspace')
    .where('deleted_at', 'is not', null)
    .where('deleted_at', '<', before)
    .returning('id')
    .execute()) as Array<{ id: string }>;
  return rows.map((r) => String(r.id));
}

export async function purgeIdempotency(before: Date): Promise<number> {
  const r = await sys('purge idempotency records').deleteFrom('serving.tenancy_idempotency').where('created_at', '<', before).executeTakeFirst();
  return Number((r as { numDeletedRows?: bigint }).numDeletedRows ?? 0);
}

export async function accountStatusOf(accountId: string): Promise<string | undefined> {
  const res = await sql<{ status: string }>`select status from serving.account where id = ${accountId}`.execute(
    sys('data rights: account status'),
  );
  return res.rows[0]?.status;
}

export async function profileForAccount(accountId: string): Promise<BusinessProfile | undefined> {
  const r = (await sys('data rights: read profile')
    .selectFrom('serving.business_profile')
    .selectAll()
    .where('account_id', '=', accountId)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapProfile(r) : undefined;
}

export async function workspacesForAccount(accountId: string): Promise<Array<Workspace & { deletedAt: Date | null }>> {
  const rows = (await sys('data rights: read workspaces')
    .selectFrom('serving.workspace')
    .selectAll()
    .where('account_id', '=', accountId)
    .orderBy('created_at', 'asc')
    .execute()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...mapWorkspace(r), deletedAt: toDateOrNull(r.deleted_at) }));
}

/** Hard-deletes all M07 rows of a closed account; returns counts. */
export async function eraseAccountTenancy(accountId: string): Promise<{ profiles: number; workspaces: number }> {
  return sys('data rights: erase tenancy')
    .transaction()
    .execute(async (trx: Db) => {
      await trx.deleteFrom('serving.tenancy_idempotency').where('account_id', '=', accountId).execute();
      const w = await trx.deleteFrom('serving.workspace').where('account_id', '=', accountId).executeTakeFirst();
      const p = await trx.deleteFrom('serving.business_profile').where('account_id', '=', accountId).executeTakeFirst();
      return {
        profiles: Number((p as { numDeletedRows?: bigint }).numDeletedRows ?? 0),
        workspaces: Number((w as { numDeletedRows?: bigint }).numDeletedRows ?? 0),
      };
    }) as Promise<{ profiles: number; workspaces: number }>;
}
