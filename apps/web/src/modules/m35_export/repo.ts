/**
 * M35 — persistence for serving.export (db/migrations/0035_m35_export.sql).
 *
 * Writes use raw SQL (not ScopedDb's query builder) because this table mixes a jsonb column
 * (`source`) with `uuid[]` columns (`canary_ids`, `company_ids`): the same combination M29's
 * serving.reveal_bulk has, handled there the identical way (repo.ts `insertRevealBulk` /
 * `updateRevealBulk`) for the same reason — node-postgres does not serialise a plain JS object
 * into jsonb on a bound parameter, so it must be JSON.stringify()'d and cast explicitly.
 */
import { sql } from 'kysely';
import { registerTenantTable, scoped, type ActorContext } from '../m01_platform/index.js';
import type { Tx } from '../m02_queue/index.js';
import type { Export, ExportFormat, ExportRow, ExportSource, ExportState } from './types.js';

registerTenantTable('serving.export', 'account');

declare module '../m01_platform/tenancy.js' {
  interface TenantTableRows {
    'serving.export': ExportRow;
  }
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapRow(r: Record<string, unknown>): Export {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    source: (typeof r.source === 'string' ? JSON.parse(r.source) : r.source) as ExportSource,
    format: r.format as ExportFormat,
    state: r.state as ExportState,
    rowCount: r.row_count === null || r.row_count === undefined ? null : Number(r.row_count),
    s3Key: (r.s3_key as string | null) ?? null,
    canaryIds: Array.isArray(r.canary_ids) ? (r.canary_ids as string[]) : [],
    companyIds: Array.isArray(r.company_ids) ? (r.company_ids as string[]) : [],
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
    expiresAt: toDate(r.expires_at),
  };
}

export interface ExportInsert {
  id: string;
  source: ExportSource;
  format: ExportFormat;
  createdAt: Date;
  expiresAt: Date;
}

export async function insertExport(ctx: ActorContext, accountId: string, row: ExportInsert): Promise<Export> {
  const db = scoped(ctx);
  const rows = await db.raw<Record<string, unknown>>(sql`
    insert into serving.export
      (id, account_id, source, format, state, row_count, s3_key, canary_ids, company_ids, created_at, updated_at, expires_at)
    values
      (${row.id}, ${accountId}, ${JSON.stringify(row.source)}::jsonb, ${row.format}, 'queued', null, null,
       '{}'::uuid[], '{}'::uuid[], ${row.createdAt}, ${row.createdAt}, ${row.expiresAt})
    returning *
  `);
  return mapRow(rows[0]!);
}

export async function findExport(ctx: ActorContext, id: string): Promise<Export | undefined> {
  const db = scoped(ctx);
  const rows = await db.raw<Record<string, unknown>>(sql`select * from serving.export where account_id = ${ctx.accountId} and id = ${id}`);
  return rows[0] ? mapRow(rows[0]) : undefined;
}

/** Sum of `row_count` for this account's `ready` exports created since `since` (LLD Job step 3:
 * "the row cap is entitlements.exportRowsPerMonth minus this month's usage"). */
export async function monthlyReadyRowUsage(ctx: ActorContext, since: Date): Promise<number> {
  const db = scoped(ctx);
  const rows = await db.raw<{ total: string | number | bigint | null }>(sql`
    select coalesce(sum(row_count), 0) as total from serving.export
    where account_id = ${ctx.accountId} and state = 'ready' and created_at >= ${since}
  `);
  return Number(rows[0]?.total ?? 0);
}

export async function markExportState(ctx: ActorContext, id: string, state: 'running' | 'failed', now: Date): Promise<void> {
  const db = scoped(ctx);
  await db.raw(sql`update serving.export set state = ${state}, updated_at = ${now} where account_id = ${ctx.accountId} and id = ${id}`);
}

export interface ExportReadyPatch {
  rowCount: number;
  s3Key: string;
  canaryIds: readonly string[];
  companyIds: readonly string[];
}

export async function markExportReady(ctx: ActorContext, id: string, patch: ExportReadyPatch, now: Date): Promise<void> {
  const db = scoped(ctx);
  await db.raw(sql`
    update serving.export
    set state = 'ready', row_count = ${patch.rowCount}, s3_key = ${patch.s3Key},
        canary_ids = ${[...patch.canaryIds]}::uuid[], company_ids = ${[...patch.companyIds]}::uuid[], updated_at = ${now}
    where account_id = ${ctx.accountId} and id = ${id}
  `);
}

// ---- system / event-handler path (EV-04; no ActorContext, runs across accounts) ---------------

export interface SystemExportRow {
  id: string;
  account_id: string;
  s3_key: string | null;
}

/** LLD M35 EV-04 handler: "cancel exports in queued or running state." Runs across every
 * account, on the event handler's own unscoped transaction, mirroring M10's and M33's own
 * EV-* handlers. */
export async function cancelInFlightExports(tx: Tx, now: Date): Promise<number> {
  const rows = await sql<{ id: string }>`
    update serving.export set state = 'cancelled', updated_at = ${now} where state in ('queued', 'running') returning id
  `.execute(tx);
  return rows.rows.length;
}

/** LLD M35 EV-04 handler: "Delete ready files whose source contained a suppressed company. The
 * check uses a company_ids list kept alongside each export." Returns the exports that matched. */
export async function readyExportsCarryingCompanies(tx: Tx, companyIds: readonly string[]): Promise<SystemExportRow[]> {
  if (companyIds.length === 0) return [];
  const rows = await sql<SystemExportRow>`
    select id, account_id, s3_key from serving.export
    where state = 'ready' and company_ids && ${[...companyIds]}::uuid[]
  `.execute(tx);
  return rows.rows;
}

export async function markExportCancelledAfterSuppression(tx: Tx, id: string, now: Date): Promise<void> {
  await sql`update serving.export set state = 'cancelled', s3_key = null, updated_at = ${now} where id = ${id}`.execute(tx);
}
