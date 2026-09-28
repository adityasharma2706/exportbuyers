/**
 * M38 — persistence for serving.rights_request (db/migrations/0038_m38_data_rights.sql).
 *
 * Request creation happens on a signed-in member's request (scoped(ctx)); the export/erase jobs
 * that finish the work run without an HTTP request, so they read/write through systemDb() with a
 * logged reason — the same split M35's own serving.export uses between its route handlers and
 * its `m35.build` job.
 */
import { sql } from 'kysely';
import { newId, registerTenantTable, scoped, systemDb, type ActorContext, type Db, type Id } from '../m01_platform/index.js';
import type { RightsRequest, RightsRequestKind, RightsRequestRow, RightsRequestState } from './types.js';

registerTenantTable('serving.rights_request', 'account');

declare module '../m01_platform/tenancy.js' {
  interface TenantTableRows {
    'serving.rights_request': RightsRequestRow;
  }
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toDateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : toDate(v);
}

function toRetained(v: unknown): string[] | null {
  if (v === null || v === undefined) return null;
  const parsed: unknown = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(parsed) ? parsed.map((x) => String(x)) : null;
}

function mapRow(r: Record<string, unknown>): RightsRequest {
  return {
    id: String(r.id) as Id<'rights_request'>,
    accountId: String(r.account_id) as Id<'account'>,
    kind: r.kind as RightsRequestKind,
    state: r.state as RightsRequestState,
    zipS3Key: (r.zip_s3_key as string | null) ?? null,
    retained: toRetained(r.retained),
    createdAt: toDate(r.created_at),
    completedAt: toDateOrNull(r.completed_at),
  };
}

const sys = (reason: string): Db => systemDb(`m38: ${reason}`);

/** Inserts a new request row for the caller's own account. */
export async function insertRequest(ctx: ActorContext, kind: RightsRequestKind, now: Date): Promise<RightsRequest> {
  const db = scoped(ctx);
  const id = newId<'rights_request'>();
  const rows = await db.raw<Record<string, unknown>>(sql`
    insert into serving.rights_request (id, account_id, kind, state, zip_s3_key, created_at, completed_at)
    values (${id}, ${ctx.accountId}, ${kind}, 'queued', null, ${now}, null)
    returning *
  `);
  return mapRow(rows[0]!);
}

/** Same as insertRequest, but for a caller already inside a transaction with no signed-in
 * ActorContext — the EV-11 `consent.withdrawn` subscriber (events.ts), which only has an
 * accountId and the outbox transaction (`meta.tx`). Writes directly against that tx so the new
 * request row commits atomically with the event being marked handled. */
export async function insertRequestTx(tx: Db, accountId: string, kind: RightsRequestKind, now: Date): Promise<RightsRequest> {
  const id = newId<'rights_request'>();
  const result = await sql<Record<string, unknown>>`
    insert into serving.rights_request (id, account_id, kind, state, zip_s3_key, created_at, completed_at)
    values (${id}, ${accountId}, ${kind}, 'queued', null, ${now}, null)
    returning *
  `.execute(tx);
  return mapRow(result.rows[0]!);
}

export async function findRequest(ctx: ActorContext, id: string): Promise<RightsRequest | undefined> {
  const db = scoped(ctx);
  const rows = await db.raw<Record<string, unknown>>(
    sql`select * from serving.rights_request where account_id = ${ctx.accountId} and id = ${id}`,
  );
  return rows[0] ? mapRow(rows[0]) : undefined;
}

/** Whether the account already has a non-terminal ('queued'|'running') request of this kind
 * (LLD's "the request stays running until all contributors succeed" implies at most one in
 * flight at a time). */
export async function findInFlightRequest(accountId: string, kind: RightsRequestKind): Promise<RightsRequest | undefined> {
  const rows = (await sys('find in-flight request')
    .selectFrom('serving.rights_request')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('kind', '=', kind)
    .where('state', 'in', ['queued', 'running'])
    .orderBy('created_at', 'desc')
    .limit(1)
    .execute()) as Array<Record<string, unknown>>;
  return rows[0] ? mapRow(rows[0]) : undefined;
}

export async function findRequestSystem(id: string): Promise<RightsRequest | undefined> {
  const rows = (await sys('read request')
    .selectFrom('serving.rights_request')
    .selectAll()
    .where('id', '=', id)
    .execute()) as Array<Record<string, unknown>>;
  return rows[0] ? mapRow(rows[0]) : undefined;
}

export async function setRequestState(id: string, state: RightsRequestState): Promise<void> {
  await sys('set request state').updateTable('serving.rights_request').set({ state }).where('id', '=', id).execute();
}

export async function markRequestDone(id: string, zipS3Key: string | null, now: Date): Promise<void> {
  await sys('mark request done')
    .updateTable('serving.rights_request')
    .set({ state: 'done', zip_s3_key: zipS3Key, completed_at: now })
    .where('id', '=', id)
    .execute();
}

/** Erase-only completion (LLD Rules step 3): also persists the retention-exception notes each
 * contributor returned, so `GET /api/me/delete/:id` (IF-38b) can surface them. */
export async function markEraseRequestDone(id: string, retained: string[], now: Date): Promise<void> {
  await sql`
    update serving.rights_request
    set state = 'done', retained = ${JSON.stringify(retained)}::jsonb, completed_at = ${now}
    where id = ${id}
  `.execute(sys('mark erase request done'));
}
