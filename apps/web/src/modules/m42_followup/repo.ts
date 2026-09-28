/**
 * M42 — persistence, in two access patterns:
 *
 *  - Request-scoped reads/writes on `serving.draft` (M34's table) and `serving.shortlist_entry`
 *    (M33's table) via `ScopedDb`, used by service.ts. `serving.draft` is already registered as an
 *    account-scoped tenant table by m34_draft/repo.ts (`registerTenantTable('serving.draft',
 *    'account')`), and `serving.shortlist_entry` by m33_pipeline/repo.ts, both of which run as an
 *    ES-module side effect once this file's own imports from `../m34_draft/index.js` and
 *    `../m33_pipeline/index.js` are evaluated — the same precondition M34's own repo.ts documents
 *    for its (equally undeclared, equally necessary) read of `serving.shortlist_entry`. Neither
 *    table is "owned" by this module; both are read/written read-only-or-append-only here, the
 *    same way M34's repo.ts reads M33's table and M41's repo.ts reads M33's table again.
 *  - Trusted-`Tx` writes on `serving.reminder` (M41's table) inside an M02 event transaction, used
 *    by events.ts. See that file's own header for why this does not go through M41's public,
 *    member-gated `createReminder`.
 */
import { newId, type Id, type ScopedDb } from '../m01_platform/index.js';
import type { Tx } from '../m02_queue/index.js';
import type { ShortlistStatus } from '../m33_pipeline/index.js';
import type { Draft, DraftHandoffVia, DraftKind, DraftTone } from '../m34_draft/index.js';

// ---- serving.draft (M34's table; read + follow-up-kind writes only) ---------------------------

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toDateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : toDate(v);
}

function mapDraft(r: Record<string, unknown>): Draft {
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

/** The parent draft named by `:parentId` (LLD M42 API). RLS (via `scoped()`) makes a draft from
 * another account invisible, so this doubles as the ownership check. */
export async function findDraftById(db: ScopedDb, id: string): Promise<Draft | undefined> {
  const r = (await db.selectFrom('serving.draft').selectAll().where('id', '=', id).executeTakeFirst()) as
    | Record<string, unknown>
    | undefined;
  return r ? mapDraft(r) : undefined;
}

export interface FollowUpDraftInsert {
  id: string;
  workspaceId: string;
  entryId: string;
  kind: DraftKind;
  /** The parent draft's id (LLD schema: `thread_parent uuid null references serving.draft (id)`). */
  threadParent: string;
  language: string;
  tone: DraftTone;
  bodyGenerated: string;
  footer: string;
  model: string;
}

export async function insertFollowUpDraft(db: ScopedDb, row: FollowUpDraftInsert, now: Date): Promise<Draft> {
  // Built as a variable, not an inline literal — see M34's own insertDraft for why (account_id is
  // auto-injected by ScopedDb for an 'account'-scoped table, but the row still needs an explicit
  // workspace_id column; TS's excess-property check only trips on inline object literals).
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
    thread_parent: row.threadParent,
    left_via: null,
    left_at: null,
    created_at: now,
  };
  const r = (await db.insertInto('serving.draft', newRow).returningAll().executeTakeFirstOrThrow()) as Record<string, unknown>;
  return mapDraft(r);
}

// ---- serving.shortlist_entry (M33's table; read-only here) ------------------------------------

export interface ShortlistEntryForFollowUp {
  id: string;
  accountId: string;
  workspaceId: string;
  companyId: string;
  status: ShortlistStatus;
}

function mapEntry(r: Record<string, unknown>): ShortlistEntryForFollowUp {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    workspaceId: String(r.workspace_id),
    companyId: String(r.company_id),
    status: r.status as ShortlistStatus,
  };
}

/** LLD M42 Rules: "Status replied, or anything further along -> CONFLICT" needs the entry's
 * current status; the parent draft's own `entry_id` names it (LLD schema). */
export async function findShortlistEntryForFollowUp(db: ScopedDb, id: string): Promise<ShortlistEntryForFollowUp | undefined> {
  const r = (await db.selectFrom('serving.shortlist_entry').selectAll().where('id', '=', id).executeTakeFirst()) as
    | Record<string, unknown>
    | undefined;
  return r ? mapEntry(r) : undefined;
}

// ---- event-handler writes on serving.reminder (M41's table; trusted Tx, no ActorContext) ------
//
// See events.ts's own header for why this writes M41's schema directly rather than through
// IF-41a's `createReminder(ctx, ...)`.

export interface DraftLeftLookup {
  id: string;
  kind: DraftKind;
}

/**
 * Finds the draft that just left the product for a given handoff (EV-09's own `entryId`/`at`).
 * Matches `left_at` exactly first (the same `now` Date instance produced both the row's `left_at`
 * and the event payload's `at`, and the row commits before the event fires — see M34's own
 * handoffDraft), then falls back to the nearest `left_at` within a small tolerance window as a
 * defensive measure against any driver-level timestamp rounding.
 */
export async function findDraftLeftAround(tx: Tx, entryId: string, leftAt: Date): Promise<DraftLeftLookup | undefined> {
  const exact = (await tx
    .selectFrom('serving.draft')
    .selectAll()
    .where('entry_id', '=', entryId)
    .where('left_at', '=', leftAt)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  if (exact) return { id: String(exact.id), kind: exact.kind as DraftKind };

  const toleranceMs = 2_000;
  const lo = new Date(leftAt.getTime() - toleranceMs);
  const hi = new Date(leftAt.getTime() + toleranceMs);
  const near = (await tx
    .selectFrom('serving.draft')
    .selectAll()
    .where('entry_id', '=', entryId)
    .where('left_at', 'is not', null)
    .where('left_at', '>=', lo)
    .where('left_at', '<=', hi)
    .orderBy('left_at', 'desc')
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return near ? { id: String(near.id), kind: near.kind as DraftKind } : undefined;
}

/** Dedupe guard: a redelivered EV-09 (or two touches leaving in quick succession) must never
 * double-book the same next-follow-up reminder. */
export async function hasOpenFollowUpReminder(tx: Tx, accountId: string, entryId: string, kind: string): Promise<boolean> {
  const row = (await tx
    .selectFrom('serving.reminder')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('entry_id', '=', entryId)
    .where('kind', '=', kind)
    .where('state', '!=', 'done')
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return row !== undefined;
}

/**
 * Writes `serving.reminder` in IF-41a's own row shape (LLD M41 Schema: `id, account_id, entry_id,
 * due_at, kind, state, created_at, updated_at`), so the row is indistinguishable — to M41's own
 * scheduler, dashboard, snooze and complete — from one created through `createReminder` itself.
 */
export async function insertFollowUpReminder(
  tx: Tx,
  accountId: string,
  entryId: string,
  kind: string,
  dueAt: Date,
  now: Date,
): Promise<void> {
  await tx
    .insertInto('serving.reminder')
    .values({
      id: newId<'reminder'>(),
      account_id: accountId,
      entry_id: entryId,
      due_at: dueAt,
      kind,
      state: 'pending',
      created_at: now,
      updated_at: now,
    })
    .execute();
}
