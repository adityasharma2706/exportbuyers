/**
 * M41 — persistence for serving.reminder, serving.notification and serving.notify_pref
 * (db/migrations/0041_m41_notify.sql). All three are account-scoped tenant tables.
 */
import { sql } from 'kysely';
import { newId, registerTenantTable, scoped, systemDb, type ActorContext, type Db, type Id, type ScopedDb } from '../m01_platform/index.js';
import {
  type Notification,
  type NotificationRow,
  type NotifyPrefRow,
  type NotifyPrefs,
  type Reminder,
  type ReminderRow,
  type ReminderState,
} from './types.js';

registerTenantTable('serving.reminder', 'account');
registerTenantTable('serving.notification', 'account');
registerTenantTable('serving.notify_pref', 'account');

declare module '../m01_platform/tenancy.js' {
  interface TenantTableRows {
    'serving.reminder': ReminderRow;
    'serving.notification': NotificationRow;
    'serving.notify_pref': NotifyPrefRow;
  }
}

// ---- mapping ----------------------------------------------------------------------------------

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toDateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : toDate(v);
}

function jsonObj(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (typeof v === 'string') {
    try {
      const p: unknown = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function mapReminder(r: Record<string, unknown>): Reminder {
  return {
    id: String(r.id) as Id<'reminder'>,
    accountId: String(r.account_id) as Id<'account'>,
    entryId: String(r.entry_id) as Id<'shortlist_entry'>,
    dueAt: toDate(r.due_at),
    kind: String(r.kind),
    state: r.state as ReminderState,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

export function mapNotification(r: Record<string, unknown>): Notification {
  return {
    id: String(r.id) as Id<'notification'>,
    accountId: String(r.account_id) as Id<'account'>,
    kind: String(r.kind),
    titleKey: String(r.title_key),
    params: jsonObj(r.params),
    companyId: r.company_id === null || r.company_id === undefined ? null : (String(r.company_id) as Id<'company'>),
    readAt: toDateOrNull(r.read_at),
    createdAt: toDate(r.created_at),
  };
}

// ---- reminder -----------------------------------------------------------------------------------

export async function insertReminder(
  db: ScopedDb,
  row: { entryId: string; dueAt: Date; kind: string },
  now: Date,
): Promise<Reminder> {
  const r = (await db
    .insertInto('serving.reminder', {
      id: newId<'reminder'>(),
      entry_id: row.entryId,
      due_at: row.dueAt,
      kind: row.kind,
      state: 'pending',
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()) as Record<string, unknown>;
  return mapReminder(r);
}

export async function findReminder(db: ScopedDb, id: string): Promise<Reminder | undefined> {
  const r = (await db.selectFrom('serving.reminder').selectAll().where('id', '=', id).executeTakeFirst()) as
    | Record<string, unknown>
    | undefined;
  return r ? mapReminder(r) : undefined;
}

export async function updateReminder(
  db: ScopedDb,
  id: string,
  set: { due_at?: Date; state?: ReminderState },
  now: Date,
): Promise<Reminder | undefined> {
  const r = (await db
    .updateTable('serving.reminder', { ...set, updated_at: now })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapReminder(r) : undefined;
}

/** IF-41c: reminders still open (not `done`) and already due, newest-due first, for one account. */
export async function listDueReminders(db: ScopedDb, now: Date, limit: number): Promise<Reminder[]> {
  const rows = (await db
    .selectFrom('serving.reminder')
    .selectAll()
    .where('state', '!=', 'done')
    .where('due_at', '<=', now)
    .orderBy('due_at', 'asc')
    .limit(limit)
    .execute()) as Array<Record<string, unknown>>;
  return rows.map(mapReminder);
}

/** Resolves `entry_id -> company_id` for a batch of shortlist entries (M33's table; read-only). */
export async function companyIdsByEntry(db: ScopedDb, entryIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (entryIds.length === 0) return out;
  const rows = (await db
    .selectFrom('serving.shortlist_entry')
    .select(['id', 'company_id'])
    .where('id', 'in', [...entryIds])
    .execute()) as Array<{ id: string; company_id: string }>;
  for (const r of rows) out.set(String(r.id), String(r.company_id));
  return out;
}

/** Ownership + existence check for createReminder: the entry must belong to this account
 * (enforced by RLS/scoped()); returns its company id, or undefined if not found. */
export async function findEntryCompanyId(db: ScopedDb, entryId: string): Promise<string | undefined> {
  const r = (await db
    .selectFrom('serving.shortlist_entry')
    .select(['company_id'])
    .where('id', '=', entryId)
    .executeTakeFirst()) as { company_id: string } | undefined;
  return r ? String(r.company_id) : undefined;
}

// ---- scheduler (system-wide; runs unscoped across accounts) --------------------------------------

export interface DueReminderForFiring {
  id: string;
  accountId: string;
  entryId: string;
  kind: string;
}

/**
 * Atomically claims up to `limit` firable reminders (LLD Rules: "every 5 minutes, fire reminders
 * with due_at <= now") by flipping them straight to `fired`. `for update skip locked` in the
 * inner select makes this safe if two scheduler ticks ever overlap: a row only comes back to one
 * caller.
 */
export async function claimDueRemindersForFiring(sdb: Db, now: Date, limit: number): Promise<DueReminderForFiring[]> {
  const updated = await sql<Record<string, unknown>>`
    update serving.reminder
    set state = 'fired', updated_at = ${now}
    where id in (
      select id from serving.reminder
      where state in ('pending', 'snoozed') and due_at <= ${now}
      order by due_at asc
      limit ${limit}
      for update skip locked
    )
    returning id, account_id, entry_id, kind
  `.execute(sdb);
  return updated.rows.map((r) => ({
    id: String(r.id),
    accountId: String(r.account_id),
    entryId: String(r.entry_id),
    kind: String(r.kind),
  }));
}

/** Unscoped lookup used only by the scheduler (it has no ActorContext to scope with). */
export async function companyIdForEntryUnscoped(sdb: Db, entryId: string): Promise<string | undefined> {
  const r = (await sdb
    .selectFrom('serving.shortlist_entry')
    .select(['company_id'])
    .where('id', '=', entryId)
    .executeTakeFirst()) as { company_id: string } | undefined;
  return r ? String(r.company_id) : undefined;
}

// ---- notification ---------------------------------------------------------------------------------

/**
 * Raw SQL (not the typed ScopedDb.insertInto builder) because `params` is a jsonb column and
 * needs an explicit `::jsonb` cast — the same reason M11 and M32's repos write their own jsonb
 * columns through `db.raw()` rather than the generic builder. `ctx.accountId` is required
 * (requireMember() has already been called by the time service.ts gets here).
 */
export async function insertNotification(
  ctx: ActorContext,
  row: { kind: string; titleKey: string; params: Record<string, unknown>; companyId: string | null },
  now: Date,
): Promise<Notification> {
  const db = scoped(ctx);
  const rows = await db.raw<Record<string, unknown>>(sql`
    insert into serving.notification (id, account_id, kind, title_key, params, company_id, read_at, created_at)
    values (${newId<'notification'>()}, ${ctx.accountId}, ${row.kind}, ${row.titleKey}, ${JSON.stringify(row.params)}::jsonb, ${row.companyId}, null, ${now})
    returning *
  `);
  return mapNotification(rows[0]!);
}

/**
 * IF-41b's in-app feed listing. Cursor-paginated (newest first) via `db.raw()` — RLS is the
 * predicate here (see ScopedDb.raw()'s own doc comment), the same way M28's usageHistory() reads
 * ledger.entry — because the `(created_at, id) < (?, ?)` keyset comparison needs a row
 * constructor that the generic ScopedDb builders do not expose.
 */
export async function listNotifications(
  db: ScopedDb,
  opts: { before?: { createdAt: Date; id: string }; limit: number },
): Promise<Notification[]> {
  const rows = opts.before
    ? await db.raw<Record<string, unknown>>(sql`
        select * from serving.notification
        where (created_at, id) < (${opts.before.createdAt}, ${opts.before.id})
        order by created_at desc, id desc
        limit ${opts.limit}
      `)
    : await db.raw<Record<string, unknown>>(sql`
        select * from serving.notification
        order by created_at desc, id desc
        limit ${opts.limit}
      `);
  return rows.map(mapNotification);
}

export async function markNotificationRead(db: ScopedDb, id: string, now: Date): Promise<Notification | undefined> {
  const r = (await db
    .updateTable('serving.notification', { read_at: now })
    .where('id', '=', id)
    .where('read_at', 'is', null)
    .returningAll()
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  if (r) return mapNotification(r);
  return findNotification(db, id);
}

export async function findNotification(db: ScopedDb, id: string): Promise<Notification | undefined> {
  const r = (await db.selectFrom('serving.notification').selectAll().where('id', '=', id).executeTakeFirst()) as
    | Record<string, unknown>
    | undefined;
  return r ? mapNotification(r) : undefined;
}

// ---- notify_pref ------------------------------------------------------------------------------------

export async function getNotifyPref(db: ScopedDb): Promise<NotifyPrefs | undefined> {
  const r = (await db.selectFrom('serving.notify_pref').select(['email', 'whatsapp']).executeTakeFirst()) as
    | { email: boolean; whatsapp: boolean }
    | undefined;
  return r ? { email: r.email === true, whatsapp: r.whatsapp === true } : undefined;
}

export async function upsertNotifyPref(db: ScopedDb, patch: Partial<NotifyPrefs>, now: Date): Promise<NotifyPrefs> {
  const existing = await getNotifyPref(db);
  const email = patch.email ?? existing?.email ?? false;
  const whatsapp = patch.whatsapp ?? existing?.whatsapp ?? false;
  const r = (await db
    .insertInto('serving.notify_pref', { email, whatsapp, updated_at: now })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .onConflict((oc: any) => oc.column('account_id').doUpdateSet({ email, whatsapp, updated_at: now }))
    .returningAll()
    .executeTakeFirstOrThrow()) as Record<string, unknown>;
  return { email: r.email === true, whatsapp: r.whatsapp === true };
}

// ---- account email lookup (for the email channel) -----------------------------------------------

/**
 * `serving.member` belongs to M05, but M41 has no dependency on M05's own repo internals — this
 * mirrors M28's own `activeAccountIds()` (reads `serving.account` directly through `systemDb()`
 * with a documented reason) and M38's `eraseJob.ts` (reads `serving.member`/`serving.session`
 * the same way): a narrow, read-only cross-module query against a shared serving-plane table,
 * rather than inventing a new IF-05 export for one lookup. Prefers the owner's email if several
 * members have one; a member with no email (phone-only sign-up) is skipped.
 */
export async function primaryEmailForAccount(accountId: string): Promise<string | undefined> {
  const rows = await sql<{ email: string }>`
    select email from serving.member
    where account_id = ${accountId} and email is not null and erased_at is null
    order by (role = 'owner') desc, created_at asc
    limit 1
  `.execute(systemDb('m41: resolve account email for a transactional notification'));
  return rows.rows[0]?.email;
}
