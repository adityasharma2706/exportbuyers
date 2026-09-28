/**
 * M33 — persistence for serving.shortlist_entry, serving.status_history and serving.note
 * (db/migrations/0033_m33_pipeline.sql).
 *
 * All three tables are registered as **account**-scoped (not workspace-scoped): PATCH
 * /api/shortlist/:id and POST/PATCH/DELETE /api/shortlist/:id/notes carry no workspace segment
 * in their URL (LLD M33 API), so `ctx.workspaceId` cannot be relied on to filter them the way
 * M01's workspace-scoped tables do (M01 `ScopedDb.scopeFor` requires it to be set). This mirrors
 * how M07 itself scopes `serving.workspace` by `account_id` alone and filters `workspace_id`-like
 * concerns (there, the row's own `id`) explicitly per query. Workspace scoping for
 * `shortlist_entry` is applied explicitly, as a normal `where`, wherever a workspace id is known
 * (add, list-by-workspace).
 */
import { sql } from 'kysely';
import { newId, registerTenantTable, type Id, type ScopedDb } from '../m01_platform/index.js';
import type { Tx } from '../m02_queue/index.js';
import {
  DEFAULT_SHORTLIST_STATUS,
  type Note,
  type NoteRow,
  type ShortlistEntry,
  type ShortlistEntryRow,
  type ShortlistStatus,
  type StatusHistoryRow,
  type StatusSource,
} from './types.js';

registerTenantTable('serving.shortlist_entry', 'account');
registerTenantTable('serving.status_history', 'account');
registerTenantTable('serving.note', 'account');

declare module '../m01_platform/tenancy.js' {
  interface TenantTableRows {
    'serving.shortlist_entry': ShortlistEntryRow;
    'serving.status_history': StatusHistoryRow;
    'serving.note': NoteRow;
  }
}

// ---- mapping --------------------------------------------------------------------------------

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toDateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : toDate(v);
}

export function mapEntry(r: Record<string, unknown>): ShortlistEntry {
  return {
    id: String(r.id) as Id<'shortlist_entry'>,
    accountId: String(r.account_id) as Id<'account'>,
    workspaceId: String(r.workspace_id) as Id<'workspace'>,
    companyId: String(r.company_id) as Id<'company'>,
    status: r.status as ShortlistStatus,
    nextActionAt: toDateOrNull(r.next_action_at),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

export function mapNote(r: Record<string, unknown>): Note {
  return {
    id: String(r.id) as Id<'note'>,
    entryId: String(r.entry_id) as Id<'shortlist_entry'>,
    body: String(r.body),
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

export const SHORTLIST_ENTRY_WORKSPACE_COMPANY_UNIQUE = 'shortlist_entry_workspace_company_uq';

// ---- shortlist_entry --------------------------------------------------------------------------

/**
 * Inserts one shortlist row, or returns `undefined` when (workspaceId, companyId) is already
 * present (LLD API: "added, alreadyPresent"). One row at a time so each id's outcome is known.
 */
export async function insertEntryIfAbsent(
  db: ScopedDb,
  accountId: string,
  workspaceId: string,
  companyId: string,
  now: Date,
): Promise<ShortlistEntry | undefined> {
  // Built as a variable (not an inline literal) so TS's excess-property check does not trip on
  // account_id/workspace_id: ScopedDb.insertInto()'s row parameter type omits both (they are
  // normally auto-injected), but this table carries workspace_id as an ordinary column too
  // (see the schema deviation note above) and must supply it itself.
  const newRow = {
    id: newId<'shortlist_entry'>(),
    account_id: accountId,
    workspace_id: workspaceId,
    company_id: companyId,
    status: DEFAULT_SHORTLIST_STATUS,
    next_action_at: null,
    created_at: now,
    updated_at: now,
  };
  const r = (await db
    .insertInto('serving.shortlist_entry', newRow)
    .onConflict((oc: { columns(c: string[]): { doNothing(): unknown } }) => oc.columns(['workspace_id', 'company_id']).doNothing())
    .returningAll()
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapEntry(r) : undefined;
}

export async function findEntryById(db: ScopedDb, id: string, forUpdate = false): Promise<ShortlistEntry | undefined> {
  let q = db.selectFrom('serving.shortlist_entry').selectAll().where('id', '=', id);
  if (forUpdate) q = q.forUpdate();
  const r = (await q.executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapEntry(r) : undefined;
}

export async function listEntries(
  db: ScopedDb,
  filter: { workspaceId?: string; status?: ShortlistStatus },
): Promise<ShortlistEntry[]> {
  let q = db.selectFrom('serving.shortlist_entry').selectAll();
  if (filter.workspaceId) q = q.where('workspace_id', '=', filter.workspaceId);
  if (filter.status) q = q.where('status', '=', filter.status);
  q = q.orderBy('created_at', 'desc').orderBy('id', 'desc');
  const rows = (await q.execute()) as Array<Record<string, unknown>>;
  return rows.map(mapEntry);
}

/** Updates status and/or next_action_at. Returns the updated row (caller already holds the lock). */
export async function updateEntry(
  db: ScopedDb,
  id: string,
  set: { status?: ShortlistStatus; next_action_at?: Date | null },
  now: Date,
): Promise<ShortlistEntry | undefined> {
  const r = (await db
    .updateTable('serving.shortlist_entry', { ...set, updated_at: now })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapEntry(r) : undefined;
}

export async function insertStatusHistory(
  db: ScopedDb,
  row: { entryId: string; accountId: string; workspaceId: string; from: ShortlistStatus | null; to: ShortlistStatus; source: StatusSource; at: Date },
): Promise<void> {
  // See insertEntryIfAbsent's comment: built as a variable so the account_id/workspace_id
  // columns (not part of insertInto()'s declared row type) do not trip TS's excess-property check.
  const newRow = {
    id: newId<'status_history'>(),
    account_id: row.accountId,
    workspace_id: row.workspaceId,
    entry_id: row.entryId,
    from_status: row.from,
    to_status: row.to,
    source: row.source,
    at: row.at,
  };
  // Kysely's InsertQueryBuilder is Compilable, not PromiseLike: without .execute() this would
  // compile (insertInto()'s declared return type is `any`) but never actually run the insert.
  await db.insertInto('serving.status_history', newRow).execute();
}

/** Notes count per entry id, for entries whose id is in `entryIds`. */
export async function notesCountByEntry(db: ScopedDb, entryIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (entryIds.length === 0) return out;
  const rows = await db.raw<{ entry_id: string; n: string | number | bigint }>(
    sql`select entry_id, count(*) as n from serving.note where entry_id = any(${[...entryIds]}::uuid[]) group by entry_id`,
  );
  for (const r of rows) out.set(String(r.entry_id), Number(r.n));
  return out;
}

// ---- note ---------------------------------------------------------------------------------------

export async function insertNote(
  db: ScopedDb,
  row: { accountId: string; workspaceId: string; entryId: string; body: string },
  now: Date,
): Promise<Note> {
  // See insertEntryIfAbsent's comment: built as a variable so the account_id/workspace_id
  // columns (not part of insertInto()'s declared row type) do not trip TS's excess-property check.
  const newRow = {
    id: newId<'note'>(),
    account_id: row.accountId,
    workspace_id: row.workspaceId,
    entry_id: row.entryId,
    body: row.body,
    created_at: now,
    updated_at: now,
  };
  const r = (await db
    .insertInto('serving.note', newRow)
    .returningAll()
    .executeTakeFirstOrThrow()) as Record<string, unknown>;
  return mapNote(r);
}

export async function findNote(db: ScopedDb, id: string, entryId: string): Promise<Note | undefined> {
  const r = (await db
    .selectFrom('serving.note')
    .selectAll()
    .where('id', '=', id)
    .where('entry_id', '=', entryId)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapNote(r) : undefined;
}

export async function updateNote(db: ScopedDb, id: string, entryId: string, body: string, now: Date): Promise<Note | undefined> {
  const r = (await db
    .updateTable('serving.note', { body, updated_at: now })
    .where('id', '=', id)
    .where('entry_id', '=', entryId)
    .returningAll()
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapNote(r) : undefined;
}

export async function deleteNote(db: ScopedDb, id: string, entryId: string): Promise<boolean> {
  const r = (await db.deleteFrom('serving.note').where('id', '=', id).where('entry_id', '=', entryId).executeTakeFirst()) as
    | { numDeletedRows?: bigint }
    | undefined;
  return Number(r?.numDeletedRows ?? 0) > 0;
}

export async function listNotesForEntry(db: ScopedDb, entryId: string): Promise<Note[]> {
  const rows = (await db
    .selectFrom('serving.note')
    .selectAll()
    .where('entry_id', '=', entryId)
    .orderBy('created_at', 'asc')
    .execute()) as Array<Record<string, unknown>>;
  return rows.map(mapNote);
}

// ---- system / event-handler path (EV-09; no ActorContext, runs across accounts) ----------------

/**
 * IF-33a auto-status hook for EV-09 `draft.left_product` (LLD Rules: "if the status is
 * `to_contact` → set it to `contacted` with source `auto_draft`. If the status is already
 * further along, do nothing."). Runs on the event handler's own transaction (`tx`, a plain
 * Kysely instance — event handlers act across accounts, so this is unscoped like M10's and
 * M30's own EV-* handlers), locking the row first so a concurrent user status change cannot
 * race it.
 */
export async function applyAutoContactedIfToContact(
  tx: Tx,
  entryId: string,
  now: Date,
): Promise<{ entry: ShortlistEntry; from: ShortlistStatus } | undefined> {
  const db = tx;
  const current = (await db
    .selectFrom('serving.shortlist_entry')
    .selectAll()
    .where('id', '=', entryId)
    .forUpdate()
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  if (!current || current.status !== DEFAULT_SHORTLIST_STATUS) return undefined;

  const updated = (await db
    .updateTable('serving.shortlist_entry')
    .set({ status: 'contacted', updated_at: now })
    .where('id', '=', entryId)
    .returningAll()
    .executeTakeFirstOrThrow()) as Record<string, unknown>;

  await db
    .insertInto('serving.status_history')
    .values({
      id: newId<'status_history'>(),
      account_id: current.account_id,
      workspace_id: current.workspace_id,
      entry_id: entryId,
      from_status: DEFAULT_SHORTLIST_STATUS,
      to_status: 'contacted',
      source: 'auto_draft',
      at: now,
    })
    .execute();

  return { entry: mapEntry(updated), from: DEFAULT_SHORTLIST_STATUS };
}
