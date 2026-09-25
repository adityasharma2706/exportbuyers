/**
 * M11 — SQL for serving.review_item and serving.review_audit. Every function takes the
 * caller's transaction (or the system Kysely instance) so writes commit with the caller.
 */
import { sql } from 'kysely';
import { newId, type Id } from '../m01_platform/index.js';
import type { Tx } from '../m02_queue/index.js';
import type {
  FiledByKind,
  HandlerResult,
  ReviewAuditAction,
  ReviewAuditEntry,
  ReviewItem,
  ReviewState,
  SlaBreachSummary,
  SubjectRef,
} from './types.js';

export interface ReviewItemRow {
  id: string;
  type: string;
  subject_refs: unknown;
  payload: unknown;
  filed_by_kind: FiledByKind;
  filed_by_ref: string | null;
  state: ReviewState;
  assignee: string | null;
  sla_due_at: Date | string;
  outcome: string | null;
  outcome_payload: unknown;
  handler_result: HandlerResult | null;
  handler_error: string | null;
  resolved_by: string | null;
  resolved_at: Date | string | null;
  dedupe_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function subjectRefsOf(v: unknown): SubjectRef[] {
  const arr = parseJson(v);
  if (!Array.isArray(arr)) return [];
  const out: SubjectRef[] = [];
  for (const r of arr) {
    if (r && typeof r === 'object' && typeof (r as SubjectRef).kind === 'string' && typeof (r as SubjectRef).id === 'string') {
      out.push({ kind: (r as SubjectRef).kind, id: (r as SubjectRef).id });
    }
  }
  return out;
}

export function rowToItem(row: ReviewItemRow, now: Date = new Date()): ReviewItem<unknown> {
  const slaDueAt = toDate(row.sla_due_at);
  const active = row.state === 'open' || row.state === 'in_review';
  return {
    id: row.id as Id<'review_item'>,
    type: row.type,
    subjectRefs: subjectRefsOf(row.subject_refs),
    payload: parseJson(row.payload),
    filedBy: { kind: row.filed_by_kind, ref: row.filed_by_ref },
    state: row.state,
    assignee: row.assignee,
    slaDueAt,
    slaBreached: active && slaDueAt.getTime() < now.getTime(),
    outcome: row.outcome,
    outcomePayload: row.outcome_payload === null ? null : parseJson(row.outcome_payload),
    handlerResult: row.handler_result,
    handlerError: row.handler_error,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at === null ? null : toDate(row.resolved_at),
    dedupeKey: row.dedupe_key,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

export interface InsertItem {
  id: string;
  type: string;
  subjectRefs: readonly SubjectRef[];
  payload: unknown;
  filedByKind: FiledByKind;
  filedByRef: string | null;
  slaDueAt: Date;
  dedupeKey: string | null;
}

/**
 * Inserts an item. With a dedupe key, a conflict with an active item of the same type is
 * ignored and `null` is returned; the caller then looks up the existing item.
 */
export async function insertItem(tx: Tx, it: InsertItem): Promise<string | null> {
  const res = await sql<{ id: string }>`
    insert into serving.review_item
      (id, type, subject_refs, payload, filed_by_kind, filed_by_ref, state, sla_due_at, dedupe_key, created_at, updated_at)
    values
      (${it.id}, ${it.type}, ${JSON.stringify(it.subjectRefs)}::jsonb, ${JSON.stringify(it.payload)}::jsonb,
       ${it.filedByKind}, ${it.filedByRef}, 'open', ${it.slaDueAt}, ${it.dedupeKey}, now(), now())
    on conflict (type, dedupe_key) where state in ('open', 'in_review') and dedupe_key is not null
    do nothing
    returning id`.execute(tx);
  return res.rows[0]?.id ?? null;
}

export async function findActiveByDedupe(tx: Tx, type: string, dedupeKey: string): Promise<string | null> {
  const res = await sql<{ id: string }>`
    select id from serving.review_item
    where type = ${type} and dedupe_key = ${dedupeKey} and state in ('open', 'in_review')
    limit 1`.execute(tx);
  return res.rows[0]?.id ?? null;
}

export async function getItemRow(tx: Tx, id: string, forUpdate = false): Promise<ReviewItemRow | null> {
  const res = forUpdate
    ? await sql<ReviewItemRow>`select * from serving.review_item where id = ${id} for update`.execute(tx)
    : await sql<ReviewItemRow>`select * from serving.review_item where id = ${id}`.execute(tx);
  return res.rows[0] ?? null;
}

export interface ListFilter {
  types: readonly string[];
  states: readonly ReviewState[];
  assignee?: string;
  limit: number;
  offset: number;
}

/** Oldest SLA first, so the console shows the most urgent work on top. */
export async function listItemRows(tx: Tx, f: ListFilter): Promise<{ rows: ReviewItemRow[]; total: number }> {
  if (f.types.length === 0 || f.states.length === 0) return { rows: [], total: 0 };
  const assigneeCond = f.assignee === undefined ? sql`true` : sql`assignee = ${f.assignee}`;
  const rows = await sql<ReviewItemRow>`
    select * from serving.review_item
    where type = any(${[...f.types]}::text[]) and state = any(${[...f.states]}::text[]) and ${assigneeCond}
    order by sla_due_at asc, id asc
    limit ${f.limit} offset ${f.offset}`.execute(tx);
  const count = await sql<{ n: string | number }>`
    select count(*) as n from serving.review_item
    where type = any(${[...f.types]}::text[]) and state = any(${[...f.states]}::text[]) and ${assigneeCond}`.execute(tx);
  return { rows: rows.rows, total: Number(count.rows[0]?.n ?? 0) };
}

export async function setClaimed(tx: Tx, id: string, assignee: string | null, state: 'open' | 'in_review'): Promise<void> {
  await sql`update serving.review_item set assignee = ${assignee}, state = ${state}, updated_at = now() where id = ${id}`.execute(tx);
}

export async function setResolved(
  tx: Tx,
  id: string,
  v: { state: 'resolved' | 'rejected'; outcome: string; outcomePayload: unknown; resolvedBy: string; assignee: string },
): Promise<void> {
  await sql`
    update serving.review_item
    set state = ${v.state}, outcome = ${v.outcome}, outcome_payload = ${JSON.stringify(v.outcomePayload ?? null)}::jsonb,
        handler_result = 'pending', handler_error = null, resolved_by = ${v.resolvedBy}, resolved_at = now(),
        assignee = ${v.assignee}, updated_at = now()
    where id = ${id}`.execute(tx);
}

export async function setHandlerResult(tx: Tx, id: string, result: HandlerResult, error: string | null): Promise<void> {
  await sql`
    update serving.review_item set handler_result = ${result}, handler_error = ${error}, updated_at = now()
    where id = ${id}`.execute(tx);
}

export async function insertAudit(
  tx: Tx,
  a: { itemId: string; actor: string | null; action: ReviewAuditAction; before: unknown; after: unknown },
): Promise<void> {
  await sql`
    insert into serving.review_audit (id, item_id, actor, action, before, after, at)
    values (${newId<'review_audit'>()}, ${a.itemId}, ${a.actor}, ${a.action},
            ${a.before === undefined || a.before === null ? null : JSON.stringify(a.before)}::jsonb,
            ${a.after === undefined || a.after === null ? null : JSON.stringify(a.after)}::jsonb, now())`.execute(tx);
}

interface AuditRow {
  id: string;
  item_id: string;
  actor: string | null;
  action: ReviewAuditAction;
  before: unknown;
  after: unknown;
  at: Date | string;
}

export async function listAudit(tx: Tx, itemId: string): Promise<ReviewAuditEntry[]> {
  const res = await sql<AuditRow>`
    select * from serving.review_audit where item_id = ${itemId} order by at asc, id asc`.execute(tx);
  return res.rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    actor: r.actor,
    action: r.action,
    before: parseJson(r.before),
    after: parseJson(r.after),
    at: toDate(r.at),
  }));
}

export async function slaBreaches(tx: Tx, now: Date): Promise<SlaBreachSummary[]> {
  const res = await sql<{ type: string; n: string | number; oldest: Date | string }>`
    select type, count(*) as n, min(sla_due_at) as oldest
    from serving.review_item
    where state in ('open', 'in_review') and sla_due_at < ${now}
    group by type
    order by min(sla_due_at) asc`.execute(tx);
  return res.rows.map((r) => ({ type: r.type, count: Number(r.n), oldestDueAt: toDate(r.oldest) }));
}
