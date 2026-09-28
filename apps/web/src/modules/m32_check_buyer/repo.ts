/**
 * M32 — persistence for `serving.check_run` (db/migrations/0032_m32_check_a_buyer.sql). LLD M32:
 * "The input is stored in serving.check_run(id, account_id, input_enc, result jsonb, created_at)
 * for the user's history. Nothing is written to knowledge." Only ever called for signed-in
 * accounts (see service.ts): there is no account row to attach an anonymous visitor's check to, so
 * anonymous checks are not persisted — there is no "history" page for a visitor with no account.
 */
import { sql } from 'kysely';
import { registerTenantTable, scoped, type ActorContext } from '../m01_platform/index.js';

export interface CheckRunRow {
  id: string;
  account_id: string;
  input_enc: Buffer;
  result: Record<string, unknown>;
  created_at: Date;
}

registerTenantTable('serving.check_run', 'account');

declare module '../m01_platform/tenancy.js' {
  interface TenantTableRows {
    'serving.check_run': CheckRunRow;
  }
}

export interface CheckRunInsert {
  id: string;
  inputEnc: Buffer;
  result: Record<string, unknown>;
}

export async function insertCheckRun(ctx: ActorContext, params: CheckRunInsert): Promise<void> {
  const db = scoped(ctx);
  await db.raw(sql`
    insert into serving.check_run (id, account_id, input_enc, result, created_at)
    values (${params.id}, ${ctx.accountId}, ${params.inputEnc}, ${JSON.stringify(params.result)}::jsonb, now())
  `);
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapRow(r: Record<string, unknown>): CheckRunRow {
  const result = typeof r.result === 'string' ? (JSON.parse(r.result) as Record<string, unknown>) : ((r.result as Record<string, unknown>) ?? {});
  return {
    id: String(r.id),
    account_id: String(r.account_id),
    input_enc: Buffer.isBuffer(r.input_enc) ? r.input_enc : Buffer.from(r.input_enc as Buffer),
    result,
    created_at: toDate(r.created_at),
  };
}

/** For a future "my checks" history view; not wired to a route by this module (LLD only requires
 * the write for now — "for the user's history" names the intent, not yet a read endpoint). */
export async function listCheckRuns(ctx: ActorContext, limit = 50): Promise<CheckRunRow[]> {
  const db = scoped(ctx);
  const rows = await db.raw<Record<string, unknown>>(sql`
    select * from serving.check_run where account_id = ${ctx.accountId} order by created_at desc limit ${limit}
  `);
  return rows.map(mapRow);
}
