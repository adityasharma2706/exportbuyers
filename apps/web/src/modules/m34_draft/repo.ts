/**
 * M34 — persistence for serving.draft (db/migrations/0034_m34_draft.sql), plus a read-only
 * lookup into M33's serving.shortlist_entry (below).
 *
 * [deviation: M34's declared deps (docs/implementer.md) include M33, and the LLD API
 * (`POST /api/drafts {entryId, ...}`) needs to resolve an entryId to its company/workspace
 * before anything else runs (LLD sequence step 1: `assertAllowed(ctx,'draft',companyId,'draft')`
 * — companyId, not entryId). M33's own public API (m33_pipeline/index.ts) exports no
 * entry-by-id lookup for other modules to call (its `findEntryById` is private to its own
 * repo.ts). serving.shortlist_entry is nonetheless already a shared, account-scoped
 * `TenantTable` (M33 registers it; M01's `scoped()` enforces the account filter at the query
 * layer regardless of which module issues the query), so this file reads it directly — read
 * only, and only the three columns this module needs — the same way M30's own repo.ts reads
 * `serving.user_hide` (a table it does not own) via `systemDb`/`sql` rather than through another
 * module's index.ts. Importing anything from `m33_pipeline/index.js` elsewhere in this module
 * (service.ts imports `EV_DRAFT_LEFT_PRODUCT`) guarantees M33's repo.ts has already run its
 * `registerTenantTable('serving.shortlist_entry', 'account')` call before this file's queries
 * execute, via ordinary ES module evaluation.]
 */
import { sql } from 'kysely';
import { registerTenantTable, scoped, type ActorContext, type Id, type ScopedDb } from '../m01_platform/index.js';
import type { Draft, DraftHandoffVia, DraftKind, DraftRow, DraftTone } from './types.js';

registerTenantTable('serving.draft', 'account');

declare module '../m01_platform/tenancy.js' {
  interface TenantTableRows {
    'serving.draft': DraftRow;
  }
}

// ---- mapping ----------------------------------------------------------------------------------

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toDateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : toDate(v);
}

export function mapDraft(r: Record<string, unknown>): Draft {
  return {
    id: String(r.id) as Id<'draft'>,
    accountId: String(r.account_id) as Id<'account'>,
    workspaceId: String(r.workspace_id) as Id<'workspace'>,
    entryId: String(r.entry_id) as Id<'shortlist_entry'>,
    kind: r.kind as DraftKind,
    language: String(r.language),
    tone: r.tone as DraftTone,
    bodyGenerated: String(r.body_generated),
    footer: String(r.footer),
    bodyEdited: r.body_edited === null || r.body_edited === undefined ? null : String(r.body_edited),
    model: String(r.model),
    threadParent: r.thread_parent ? (String(r.thread_parent) as Id<'draft'>) : null,
    leftVia: (r.left_via as DraftHandoffVia | null) ?? null,
    leftAt: toDateOrNull(r.left_at),
    createdAt: toDate(r.created_at),
  };
}

// ---- serving.shortlist_entry (M33's table; read-only here — see the module doc comment) -------

export interface ShortlistEntryLite {
  id: string;
  accountId: string;
  workspaceId: string;
  companyId: string;
}

function mapEntryLite(r: Record<string, unknown>): ShortlistEntryLite {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    workspaceId: String(r.workspace_id),
    companyId: String(r.company_id),
  };
}

export async function findShortlistEntryById(db: ScopedDb, id: string): Promise<ShortlistEntryLite | undefined> {
  const r = (await db.selectFrom('serving.shortlist_entry').selectAll().where('id', '=', id).executeTakeFirst()) as
    | Record<string, unknown>
    | undefined;
  return r ? mapEntryLite(r) : undefined;
}

// ---- serving.draft: rate limiting ---------------------------------------------------------------

/** LLD M34 Rules: "Rate limit: 50 drafts per account per day [tunable]." Same rolling-24h-window
 * pattern as M30's own `countReportsSince`. */
export async function countDraftsSince(ctx: ActorContext, since: Date): Promise<number> {
  const db = scoped(ctx);
  const rows = await db.raw<{ count: string }>(
    sql`select count(*)::int as count from serving.draft where account_id = ${ctx.accountId} and created_at >= ${since}`,
  );
  return Number(rows[0]?.count ?? 0);
}

// ---- serving.draft: writes ----------------------------------------------------------------------

export interface DraftInsert {
  id: string;
  workspaceId: string;
  entryId: string;
  kind: DraftKind;
  language: string;
  tone: DraftTone;
  bodyGenerated: string;
  footer: string;
  model: string;
}

export async function insertDraft(db: ScopedDb, row: DraftInsert, now: Date): Promise<Draft> {
  // Built as a variable (not an inline literal) so TS's excess-property check does not trip on
  // workspace_id: ScopedDb.insertInto()'s row parameter type omits it (account/workspace-scoped
  // tables normally have it auto-injected), but this table is registered 'account'-scoped while
  // still carrying an ordinary workspace_id column (see the migration's doc comment) — the same
  // pattern M33's own insertEntryIfAbsent uses for exactly this reason.
  const newRow = {
    id: row.id,
    workspace_id: row.workspaceId,
    entry_id: row.entryId,
    kind: row.kind,
    language: row.language,
    tone: row.tone,
    body_generated: row.bodyGenerated,
    footer: row.footer,
    body_edited: null,
    model: row.model,
    thread_parent: null,
    left_via: null,
    left_at: null,
    created_at: now,
  };
  const r = (await db.insertInto('serving.draft', newRow).returningAll().executeTakeFirstOrThrow()) as Record<string, unknown>;
  return mapDraft(r);
}

export async function findDraftById(db: ScopedDb, id: string): Promise<Draft | undefined> {
  const r = (await db.selectFrom('serving.draft').selectAll().where('id', '=', id).executeTakeFirst()) as
    | Record<string, unknown>
    | undefined;
  return r ? mapDraft(r) : undefined;
}

/** PATCH /api/drafts/:id {bodyEdited} (LLD M34 API). No `updated_at` column on serving.draft
 * (the LLD schema does not list one), so none is set here. */
export async function updateDraftBodyEdited(db: ScopedDb, id: string, bodyEdited: string): Promise<Draft | undefined> {
  const r = (await db
    .updateTable('serving.draft', { body_edited: bodyEdited })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapDraft(r) : undefined;
}

/** POST /api/drafts/:id/handoff {via} (LLD M34 IF-34c). */
export async function markDraftLeft(db: ScopedDb, id: string, via: DraftHandoffVia, at: Date): Promise<Draft | undefined> {
  const r = (await db
    .updateTable('serving.draft', { left_via: via, left_at: at })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapDraft(r) : undefined;
}
