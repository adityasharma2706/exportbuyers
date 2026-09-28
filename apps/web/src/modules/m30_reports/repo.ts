/**
 * M30 — persistence (db/migrations/0030_m30_reports.sql).
 *
 * Three groups of functions:
 *   - serving.user_hide / serving.report / serving.report_refund_usage: M30's own tables,
 *     read and written the normal tenant-scoped way (via `scoped(ctx)`) on the request path, and
 *     via `systemDb()` / a caller-supplied `Tx` on the async (event, job, review-outcome) paths,
 *     which act across accounts and so cannot go through one actor's RLS session.
 *   - A read-only join into M29's `serving.reveal` / `serving.reveal_contact` (IF-29a's own
 *     schema) to answer LLD M30's "a matching reveal_contact from this account": M29's public API
 *     (IF-29a/b) has no "find the reveal behind this (account, assertion)" primitive, and
 *     `revealedContacts()` does not surface `commit_entry_id` (needed as refund()'s `refersTo`).
 *     [deviation: reads `serving.reveal`/`serving.reveal_contact` directly with raw SQL rather
 *     than through M29's exported functions, for that reason. Read-only; nothing here writes to
 *     another module's table except the one documented exception below.]
 *   - A read-only lookup into M28's `ledger.entry` for the credits actually committed on a
 *     reveal, for the same reason (IF-28a exposes no "get an entry by id").
 *   - [deviation] one write into M11's `serving.review_item.payload`, to keep the `report.content`
 *     item's "counter in the payload" (LLD M30 Rules) live as further reports arrive. IF-11a
 *     `file()` has no primitive to update an existing (dedupe-hit) item's payload — it is designed
 *     to return the existing item id unchanged — so there is no official write path for this; the
 *     LLD's requirement is otherwise unmet. app_serving already owns read/write on every table in
 *     the `serving` schema (M11's migration only revokes UPDATE/DELETE on `review_audit`, not
 *     `review_item`), so this is a schema-permitted, narrowly-scoped (`count` key only, via a
 *     jsonb merge) write, not a privilege escalation.
 */
import { sql } from 'kysely';
import { registerTenantTable, scoped, systemDb, type ActorContext, type ScopedDb } from '../m01_platform/index.js';
import type { Tx } from '../m02_queue/index.js';
import type { HideTargetKind, RefundKind, ReportReason, ReportRow, ReportState, UserHideRow } from './types.js';

registerTenantTable('serving.user_hide', 'account');
registerTenantTable('serving.report', 'account');
registerTenantTable('serving.report_refund_usage', 'account');

declare module '../m01_platform/tenancy.js' {
  interface TenantTableRows {
    'serving.user_hide': UserHideRow;
    'serving.report': ReportRow;
    'serving.report_refund_usage': { account_id: string; period: string; used: number; updated_at: Date };
  }
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapReport(r: Record<string, unknown>): ReportRow {
  return {
    id: String(r.id),
    account_id: String(r.account_id),
    company_id: String(r.company_id),
    assertion_id: r.assertion_id == null ? null : String(r.assertion_id),
    reason: r.reason as ReportReason,
    note: r.note == null ? null : String(r.note),
    reveal_id: r.reveal_id == null ? null : String(r.reveal_id),
    state: r.state as ReportState,
    review_item_id: r.review_item_id == null ? null : String(r.review_item_id),
    refund_kind: r.refund_kind == null ? null : (r.refund_kind as RefundKind),
    refund_period: r.refund_period == null ? null : String(r.refund_period),
    refund_credits: r.refund_credits == null ? null : Number(r.refund_credits),
    refund_entry_id: r.refund_entry_id == null ? null : String(r.refund_entry_id),
    created_at: toDate(r.created_at),
    updated_at: toDate(r.updated_at),
  };
}

// ---- serving.user_hide (IF-30b: M10's userHides provider reads from here) --------------------

/** Inserts (or no-ops on) a hide, inside the caller's scoped transaction. */
export async function insertUserHide(db: ScopedDb, accountId: string, kind: HideTargetKind, targetId: string): Promise<void> {
  await db.raw(sql`
    insert into serving.user_hide (account_id, target_kind, target_id, created_at)
    values (${accountId}, ${kind}, ${targetId}, now())
    on conflict (account_id, target_kind, target_id) do nothing
  `);
}

/** DELETE /api/hides/:kind/:id. Returns whether a row was actually removed. */
export async function deleteUserHide(ctx: ActorContext, kind: HideTargetKind, targetId: string): Promise<boolean> {
  const db = scoped(ctx);
  const rows = await db.raw<{ target_id: string }>(sql`
    delete from serving.user_hide where account_id = ${ctx.accountId} and target_kind = ${kind} and target_id = ${targetId}
    returning target_id
  `);
  return rows.length > 0;
}

/** IF-10b `userHides` provider: every company id this account has hidden. */
export async function hiddenCompanies(accountId: string): Promise<Set<string>> {
  const db = systemDb('m30: IF-10b userHides.hiddenCompanies');
  const rows = await sql<{ target_id: string }>`
    select target_id from serving.user_hide where account_id = ${accountId} and target_kind = 'company'
  `.execute(db);
  return new Set(rows.rows.map((r) => String(r.target_id)));
}

/** IF-10b `userHides` provider: every assertion id this account has hidden. */
export async function hiddenAssertions(accountId: string): Promise<Set<string>> {
  const db = systemDb('m30: IF-10b userHides.hiddenAssertions');
  const rows = await sql<{ target_id: string }>`
    select target_id from serving.user_hide where account_id = ${accountId} and target_kind = 'assertion'
  `.execute(db);
  return new Set(rows.rows.map((r) => String(r.target_id)));
}

// ---- serving.report: request path (tenant-scoped) ----------------------------------------------

/** LLD M30 Rules: "Reports are rate-limited to 30 per account per day." */
export async function countReportsSince(ctx: ActorContext, since: Date): Promise<number> {
  const db = scoped(ctx);
  const rows = await db.raw<{ count: string }>(sql`
    select count(*)::int as count from serving.report where account_id = ${ctx.accountId} and created_at >= ${since}
  `);
  return Number(rows[0]?.count ?? 0);
}

export interface ReportInsert {
  id: string;
  companyId: string;
  assertionId: string | null;
  reason: ReportReason;
  note: string | null;
  revealId: string | null;
  state: ReportState;
}

export async function insertReport(db: ScopedDb, accountId: string, r: ReportInsert): Promise<void> {
  await db.raw(sql`
    insert into serving.report (id, account_id, company_id, assertion_id, reason, note, reveal_id, state, created_at, updated_at)
    values (${r.id}, ${accountId}, ${r.companyId}, ${r.assertionId}, ${r.reason}, ${r.note}, ${r.revealId}, ${r.state}, now(), now())
  `);
}

export async function setReportReviewItemId(db: ScopedDb, reportId: string, reviewItemId: string): Promise<void> {
  await db.raw(sql`update serving.report set review_item_id = ${reviewItemId}, updated_at = now() where id = ${reportId}`);
}

/** Same update, for the async (system Tx) path used right after filing a content report. */
export async function setReportReviewItemIdTx(tx: Tx, reportId: string, reviewItemId: string): Promise<void> {
  await sql`update serving.report set review_item_id = ${reviewItemId}, updated_at = now() where id = ${reportId}`.execute(tx);
}

/** M29's serving.reveal / serving.reveal_contact, correlated for "a matching reveal_contact from
 * this account" (LLD M30 Rules). Read-only; see the file header for why this is direct SQL. */
export interface CorrelatedReveal {
  revealId: string;
  commitEntryId: string | null;
}

export async function findRevealForContact(ctx: ActorContext, assertionId: string, companyId: string): Promise<CorrelatedReveal | null> {
  const db = scoped(ctx);
  const rows = await db.raw<{ reveal_id: string; commit_entry_id: string | null }>(sql`
    select r.id as reveal_id, r.commit_entry_id
    from serving.reveal_contact rc
    join serving.reveal r on r.id = rc.reveal_id and r.account_id = rc.account_id
    where rc.account_id = ${ctx.accountId} and rc.assertion_id = ${assertionId} and r.company_id = ${companyId} and r.state = 'done'
    limit 1
  `);
  const row = rows[0];
  if (!row) return null;
  return { revealId: String(row.reveal_id), commitEntryId: row.commit_entry_id == null ? null : String(row.commit_entry_id) };
}

// ---- serving.report: async path (system-wide; a caller-supplied Tx or systemDb()) -------------

/** Every report waiting on this assertion's re-verification (any account), for the EV-06 handlers. */
export async function findReverifyingReportsByAssertion(tx: Tx, assertionId: string): Promise<ReportRow[]> {
  const rows = await sql<Record<string, unknown>>`
    select * from serving.report where assertion_id = ${assertionId} and state = 'reverifying'
  `.execute(tx);
  return rows.rows.map(mapReport);
}

/** Reports still `reverifying` past the timeout (LLD: "if M25 reports unknown after 24 h"). */
export async function findTimedOutReverifyingReports(tx: Tx, cutoff: Date, limit: number): Promise<ReportRow[]> {
  const rows = await sql<Record<string, unknown>>`
    select * from serving.report where state = 'reverifying' and created_at <= ${cutoff} order by created_at asc limit ${limit}
  `.execute(tx);
  return rows.rows.map(mapReport);
}

export async function getReportById(tx: Tx, id: string): Promise<ReportRow | null> {
  const rows = await sql<Record<string, unknown>>`select * from serving.report where id = ${id} limit 1`.execute(tx);
  return rows.rows[0] ? mapReport(rows.rows[0]) : null;
}

/** Re-fetches and locks one report row by id, only if it is still in `fromState` (optimistic
 * concurrency: two triggers — an EV-06 event and the timeout sweep — can race for the same report). */
export async function lockReportIfState(tx: Tx, id: string, fromState: ReportState): Promise<ReportRow | null> {
  const rows = await sql<Record<string, unknown>>`
    select * from serving.report where id = ${id} and state = ${fromState} for update
  `.execute(tx);
  return rows.rows[0] ? mapReport(rows.rows[0]) : null;
}

export interface ReportRefundedPatch {
  refundKind: RefundKind;
  refundPeriod: string | null;
  refundCredits: number;
  refundEntryId: string;
}

export async function setReportRefunded(tx: Tx, id: string, patch: ReportRefundedPatch): Promise<void> {
  await sql`
    update serving.report
    set state = 'refunded', refund_kind = ${patch.refundKind}, refund_period = ${patch.refundPeriod},
        refund_credits = ${patch.refundCredits}, refund_entry_id = ${patch.refundEntryId}, updated_at = now()
    where id = ${id}
  `.execute(tx);
}

export async function setReportState(tx: Tx, id: string, state: ReportState): Promise<void> {
  await sql`update serving.report set state = ${state}, updated_at = now() where id = ${id}`.execute(tx);
}

export async function setReportReviewException(tx: Tx, id: string, reviewItemId: string): Promise<void> {
  await sql`
    update serving.report set state = 'review', review_item_id = ${reviewItemId}, updated_at = now() where id = ${id}
  `.execute(tx);
}

/** Every open/reverifying/review report row filed under the same M11 review item (content reports:
 * many accounts' reports collapse into one deduped item). Used to close them out on resolve. */
export async function closeReportsForReviewItem(tx: Tx, reviewItemId: string): Promise<void> {
  await sql`
    update serving.report set state = 'closed', updated_at = now()
    where review_item_id = ${reviewItemId} and state <> 'closed'
  `.execute(tx);
}

// ---- serving.report_refund_usage: the monthly unconfirmed-refund cap --------------------------

/**
 * Atomically checks and (if allowed) consumes one unit of this account's monthly unconfirmed-
 * refund allowance. Must run inside `tx` alongside the refund itself, so a retried event handler
 * cannot double-count. Returns the row's `used` count *after* this call.
 */
export async function tryConsumeRefundCap(tx: Tx, accountId: string, period: string, cap: number): Promise<{ allowed: boolean; used: number }> {
  await sql`
    insert into serving.report_refund_usage (account_id, period, used, updated_at) values (${accountId}, ${period}, 0, now())
    on conflict (account_id, period) do nothing
  `.execute(tx);
  const rows = await sql<{ used: number }>`
    select used from serving.report_refund_usage where account_id = ${accountId} and period = ${period} for update
  `.execute(tx);
  const used = Number(rows.rows[0]?.used ?? 0);
  if (used >= cap) return { allowed: false, used };
  await sql`
    update serving.report_refund_usage set used = used + 1, updated_at = now() where account_id = ${accountId} and period = ${period}
  `.execute(tx);
  return { allowed: true, used: used + 1 };
}

// ---- read-only cross-module lookups (see file header) ------------------------------------------

/** M29's `serving.reveal.commit_entry_id` for an already-correlated reveal. Null both when the
 * reveal used the free allowance (no commit was ever made) and when the reveal row has vanished
 * (should not happen; M29 never deletes reveal rows). */
export async function getRevealCommitEntry(tx: Tx, revealId: string): Promise<string | null> {
  const rows = await sql<{ commit_entry_id: string | null }>`
    select commit_entry_id from serving.reveal where id = ${revealId} limit 1
  `.execute(tx);
  const row = rows.rows[0];
  return row?.commit_entry_id == null ? null : String(row.commit_entry_id);
}

/** Number of contacts revealed together with `assertionId` (LLD: "the per-contact share"). */
export async function countRevealContacts(tx: Tx, revealId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::int as count from serving.reveal_contact where reveal_id = ${revealId}
  `.execute(tx);
  return Math.max(1, Number(rows.rows[0]?.count ?? 1));
}

/** Credits actually committed for a reveal's ledger entry (ledger.entry, M28's schema). Null when
 * the reveal was covered by the free allowance (no commit — LLD M29: `commit_entry_id` is then null). */
export async function commitEntryCredits(tx: Tx, commitEntryId: string): Promise<number | null> {
  const rows = await sql<{ credits: number }>`
    select credits from ledger.entry where id = ${commitEntryId} and kind = 'commit' and bucket = 'spent' limit 1
  `.execute(tx);
  const row = rows.rows[0];
  return row ? Number(row.credits) : null;
}

// ---- [deviation] the report.content live counter — see file header -----------------------------

export async function bumpReviewItemCount(tx: Tx, reviewItemId: string, count: number): Promise<void> {
  await sql`
    update serving.review_item
    set payload = payload || jsonb_build_object('count', ${count}::int), updated_at = now()
    where id = ${reviewItemId} and type = 'report.content'
  `.execute(tx);
}

/** Current distinct-report count for a (company, reason) pair, used to seed / refresh the counter. */
export async function countReportsForCompanyReason(tx: Tx, companyId: string, reason: ReportReason): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::int as count from serving.report where company_id = ${companyId} and reason = ${reason}
  `.execute(tx);
  return Number(rows.rows[0]?.count ?? 0);
}
