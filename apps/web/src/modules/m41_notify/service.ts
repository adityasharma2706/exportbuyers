/**
 * M41 — reminders (IF-41a), notifications (IF-41b) and the dashboard read model (IF-41c).
 * REQ-047 (reminders + opt-in notifications on a shortlisted buyer), REQ-049 (dashboard).
 *
 * `notify()` (LLD M41 Rules):
 *   1. Checks M10 `byIds(systemCtxFor(account), 'notify', [companyId])` when `companyId` is
 *      given, and drops the notification (no write at all) if the company is hidden.
 *   2. Always writes the in-app row (`serving.notification`).
 *   3. If the account's `notify_pref.email` is on, sends a transactional email via M05's
 *      `sendTransactionalEmail` (from `notify.<domain>`; see M05's own config default).
 *      [deviation: the LLD's condition also reads "and marketing-class consent is not required
 *      for this transactional kind" — a per-kind M06 consent-class check. M06 (Consent) is not
 *      one of this module's declared deps (implementer.md: M02, M10, M28, M33), and every kind
 *      this module and its callers (M33, M42, M45, M20 via EV-05, M31) define is transactional
 *      account activity, not marketing content, so the condition is met by construction; no M06
 *      call is made here. If a future caller ever needs to send genuinely marketing-class
 *      content through this path, it must gate that at the call site with M06 first.]
 *      [deviation: M41 also imports M05 for this (`sendTransactionalEmail`), though
 *      implementer.md's Deps list for M41 gives only M02/M10/M28/M33 — required by the LLD's own
 *      wording ("it sends email via M05's sendTransactionalEmail"); M05 already exists.]
 *   4. WhatsApp: [deviation: M50 (WhatsApp notifications) does not exist yet. The LLD text is
 *      itself conditional ("if ... M50 exists"), so `notify_pref.whatsapp` is read and logged but
 *      never acted on until M50 lands and this module is wired to its `sendTemplate`.]
 */
import { sql } from 'kysely';
import { AppError, log, scoped, withSpan, type ActorContext, type Id } from '../m01_platform/index.js';
import { requireMember, sendTransactionalEmail } from '../m05_identity/index.js';
import { byIds } from '../m10_policy/index.js';
import { balance } from '../m28_credits/index.js';
import { SHORTLIST_STATUSES } from '../m33_pipeline/index.js';
import { notifyConfig } from './config.js';
import {
  companyIdsByEntry,
  findEntryCompanyId,
  findNotification,
  findReminder,
  getNotifyPref,
  insertNotification,
  insertReminder,
  listDueReminders,
  listNotifications,
  markNotificationRead,
  primaryEmailForAccount,
  updateReminder,
  upsertNotifyPref,
} from './repo.js';
import { systemCtxFor } from './systemCtx.js';
import {
  DEFAULT_NOTIFY_PREFS,
  type DashboardDto,
  type NotificationDto,
  type NotifyInput,
  type NotifyPrefs,
  type Reminder,
  type ReminderDto,
} from './types.js';
import {
  parseAccountId,
  parseBooleanOptional,
  parseCompanyIdOptional,
  parseCursorLimit,
  parseEntryId,
  parseKind,
  parseNotificationIdParam,
  parseParams,
  parseReminderIdParam,
  parseTimestamp,
  parseTitleKey,
} from './validate.js';

function reminderNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Reminder not found');
}

function notificationNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Notification not found');
}

function toReminderDto(r: Reminder, companyId: string | null): ReminderDto {
  return { id: r.id, entryId: r.entryId, companyId, dueAt: r.dueAt.toISOString(), kind: r.kind, state: r.state };
}

// ---- IF-41a reminders ---------------------------------------------------------------------------

/** `createReminder(ctx, entryId, dueAt, kind)`. The entry must belong to the caller's account
 * (M33's `serving.shortlist_entry` is account-scoped, so RLS makes a foreign entry invisible). */
export async function createReminder(ctx: ActorContext, entryId: unknown, dueAt: unknown, kind: unknown): Promise<ReminderDto> {
  requireMember(ctx);
  const eid = parseEntryId(entryId);
  const due = parseTimestamp(dueAt, 'dueAt');
  const k = parseKind(kind);
  const sdb = scoped(ctx);

  return withSpan('m41.createReminder', async () => {
    const companyId = await findEntryCompanyId(sdb, eid);
    if (companyId === undefined) throw new AppError('NOT_FOUND', 'Shortlist entry not found');
    const reminder = await insertReminder(sdb, { entryId: eid, dueAt: due, kind: k }, new Date());
    return toReminderDto(reminder, companyId);
  });
}

/** `snooze(ctx, id, until)`. Sets state to `snoozed` and moves `due_at` to `until`; the
 * scheduler treats `snoozed` the same as `pending` for firing purposes (FIRABLE_REMINDER_STATES
 * in types.ts), so a snoozed reminder fires again once the new time passes. */
export async function snooze(ctx: ActorContext, id: unknown, until: unknown): Promise<ReminderDto> {
  requireMember(ctx);
  const rid = parseReminderIdParam(id);
  const newDue = parseTimestamp(until, 'until');
  const sdb = scoped(ctx);

  const current = await findReminder(sdb, rid);
  if (!current) throw reminderNotFound();
  if (current.state === 'done') throw new AppError('CONFLICT', 'Reminder was already completed');

  const updated = await updateReminder(sdb, rid, { due_at: newDue, state: 'snoozed' }, new Date());
  if (!updated) throw reminderNotFound();
  const companyId = await findEntryCompanyId(sdb, updated.entryId);
  return toReminderDto(updated, companyId ?? null);
}

/** `complete(ctx, id)`. Idempotent: completing an already-`done` reminder is a no-op. */
export async function complete(ctx: ActorContext, id: unknown): Promise<ReminderDto> {
  requireMember(ctx);
  const rid = parseReminderIdParam(id);
  const sdb = scoped(ctx);

  const current = await findReminder(sdb, rid);
  if (!current) throw reminderNotFound();
  const companyId = await findEntryCompanyId(sdb, current.entryId);
  if (current.state === 'done') return toReminderDto(current, companyId ?? null);

  const updated = await updateReminder(sdb, rid, { state: 'done' }, new Date());
  if (!updated) throw reminderNotFound();
  return toReminderDto(updated, companyId ?? null);
}

// ---- IF-41b notify --------------------------------------------------------------------------------

/**
 * `notify(accountId, {kind, titleKey, params, companyId?})`. Plain-function IF-41b (HLD: "lib"),
 * called by this module's own scheduler and by other modules/jobs with a bare account id — never
 * an ActorContext, since a background job has no signed-in actor.
 */
export async function notify(accountId: unknown, input: NotifyInput): Promise<void> {
  const acct = parseAccountId(accountId);
  const kind = parseKind(input.kind);
  const titleKey = parseTitleKey(input.titleKey);
  const params = parseParams(input.params);
  const companyId = parseCompanyIdOptional(input.companyId);

  await withSpan(
    'm41.notify',
    async () => {
      const sysCtx = systemCtxFor(acct);

      if (companyId !== undefined) {
        const decisions = await byIds(sysCtx, 'notify', [companyId as Id<'company'>]);
        const entry = decisions.get(companyId as Id<'company'>);
        if (!entry || !entry.doc || entry.decision.visibility === 'hidden') {
          log.info({ accountId: acct, companyId, kind }, 'm41: notification dropped, company is hidden from this surface');
          return;
        }
      }

      const notification = await insertNotification(sysCtx, { kind, titleKey, params, companyId: companyId ?? null }, new Date());

      const prefs = (await getNotifyPref(scoped(sysCtx))) ?? DEFAULT_NOTIFY_PREFS;

      if (prefs.email) {
        try {
          const to = await primaryEmailForAccount(acct);
          if (to) {
            await sendTransactionalEmail(to, kind, params, { idempotencyKey: `m41:notify:${notification.id}` });
          } else {
            log.warn({ accountId: acct, kind }, 'm41: email notifications are on but the account has no email address');
          }
        } catch (err) {
          log.error({ err, accountId: acct, kind }, 'm41: failed to send the notification email');
        }
      }

      if (prefs.whatsapp) {
        log.info({ accountId: acct, kind }, 'm41: whatsapp notifications are on but M50 is not yet built; skipping');
      }
    },
    { accountId: acct, kind },
  );
}

// ---- notification feed (in-app; supports "in-app always") ----------------------------------------

export async function listNotificationsPage(
  ctx: ActorContext,
  cursor: unknown,
  limitRaw?: unknown,
): Promise<{ items: NotificationDto[]; nextCursor: string | null }> {
  requireMember(ctx);
  const before = decodeNotificationCursor(cursor);
  const limit = parseCursorLimit(limitRaw);
  const rows = await listNotifications(scoped(ctx), { ...(before ? { before } : {}), limit });
  const items = rows.map(toNotificationDto);
  const last = rows[rows.length - 1];
  const nextCursor = rows.length === limit && last ? encodeNotificationCursor(last.createdAt, last.id) : null;
  return { items, nextCursor };
}

export async function markRead(ctx: ActorContext, id: unknown): Promise<NotificationDto> {
  requireMember(ctx);
  const nid = parseNotificationIdParam(id);
  const sdb = scoped(ctx);
  const existing = await findNotification(sdb, nid);
  if (!existing) throw notificationNotFound();
  const updated = (await markNotificationRead(sdb, nid, new Date())) ?? existing;
  return toNotificationDto(updated);
}

interface NotificationLike {
  id: string;
  kind: string;
  titleKey: string;
  params: Record<string, unknown>;
  companyId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

function toNotificationDto(n: NotificationLike): NotificationDto {
  return {
    id: n.id,
    kind: n.kind,
    titleKey: n.titleKey,
    params: n.params,
    companyId: n.companyId,
    read: n.readAt !== null,
    createdAt: n.createdAt.toISOString(),
  };
}

function encodeNotificationCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeNotificationCursor(v: unknown): { createdAt: Date; id: string } | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AppError('VALIDATION', 'cursor must be a string', { field: 'cursor' });
  let decoded: string;
  try {
    decoded = Buffer.from(v, 'base64url').toString('utf8');
  } catch {
    throw new AppError('VALIDATION', 'Malformed cursor', { field: 'cursor' });
  }
  const idx = decoded.lastIndexOf('|');
  if (idx < 0) throw new AppError('VALIDATION', 'Malformed cursor', { field: 'cursor' });
  const createdAt = new Date(decoded.slice(0, idx));
  const id = decoded.slice(idx + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) throw new AppError('VALIDATION', 'Malformed cursor', { field: 'cursor' });
  return { createdAt, id };
}

// ---- notify_pref opt-in/out -----------------------------------------------------------------------

/**
 * [addition: the LLD's "API:" block does not list an HTTP surface for `serving.notify_pref`, but
 * REQ-047 ("if the user opts in, as notifications") requires some way to flip it. Kept minimal:
 * a plain read/write pair, exported the same way M28 exposes `balance`/`allowanceRemaining`.]
 */
export async function getNotifyPrefs(ctx: ActorContext): Promise<NotifyPrefs> {
  requireMember(ctx);
  return (await getNotifyPref(scoped(ctx))) ?? DEFAULT_NOTIFY_PREFS;
}

export async function setNotifyPrefs(ctx: ActorContext, email: unknown, whatsapp: unknown): Promise<NotifyPrefs> {
  requireMember(ctx);
  const patch: { email?: boolean; whatsapp?: boolean } = {};
  const e = parseBooleanOptional(email, 'email');
  if (e !== undefined) patch.email = e;
  const w = parseBooleanOptional(whatsapp, 'whatsapp');
  if (w !== undefined) patch.whatsapp = w;
  return upsertNotifyPref(scoped(ctx), patch, new Date());
}

// ---- IF-41c dashboard ------------------------------------------------------------------------------

/** `GET /api/dashboard`. Computed live over indexed columns (LLD Rules), never cached. */
export async function dashboard(ctx: ActorContext): Promise<DashboardDto> {
  requireMember(ctx);
  const sdb = scoped(ctx);
  const now = new Date();

  return withSpan('m41.dashboard', async () => {
    const [countRows, remindersRaw, bal] = await Promise.all([
      pipelineCountsRaw(sdb),
      listDueReminders(sdb, now, notifyConfig().dashboardRemindersLimit),
      balance(ctx),
    ]);

    const pipelineCounts: Record<string, number> = {};
    for (const s of SHORTLIST_STATUSES) pipelineCounts[s] = 0;
    for (const row of countRows) pipelineCounts[row.status] = row.n;

    const companyByEntry = await companyIdsByEntry(sdb, remindersRaw.map((r) => r.entryId));
    const remindersDue = remindersRaw.map((r) => toReminderDto(r, companyByEntry.get(r.entryId) ?? null));

    return {
      pipelineCounts,
      remindersDue,
      // [deviation: see types.ts DashboardDto.savedSearchHits — M45 does not exist yet.]
      savedSearchHits: [],
      balance: bal,
    };
  });
}

/**
 * `serving.shortlist_entry` is M33's table (RLS-protected, account-scoped). Reading it through
 * this request's own account-scoped connection (`sdb.raw()`) needs no extra predicate — RLS is
 * the guard, per ScopedDb.raw()'s own contract — and the account_id index M33's migration
 * already created (`shortlist_entry_account_idx`) is what "the queries are indexed" (LLD Rules)
 * relies on here.
 */
async function pipelineCountsRaw(sdb: ReturnType<typeof scoped>): Promise<Array<{ status: string; n: number }>> {
  const rows = await sdb.raw<{ status: string; n: string | number | bigint }>(
    sql`select status, count(*)::bigint as n from serving.shortlist_entry group by status`,
  );
  return rows.map((r) => ({ status: String(r.status), n: Number(r.n) }));
}
