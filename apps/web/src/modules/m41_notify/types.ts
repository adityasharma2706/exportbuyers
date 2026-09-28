/**
 * M41 — shared types (LLD M41 "Schema" / "API").
 *
 * serving.reminder    next-action reminders on a shortlisted buyer (serving.shortlist_entry,
 *                      owned by M33), fired by the M02 scheduler.
 * serving.notification the in-app notification feed (IF-41b writes one row per notify() call
 *                      that is not dropped by the policy check).
 * serving.notify_pref  per-account opt-in flags for the email / WhatsApp channels.
 */
import type { Id } from '../m01_platform/index.js';

// ---- reminder -------------------------------------------------------------------------------

/** LLD M41 schema: serving.reminder.state check constraint. */
export const REMINDER_STATES = ['pending', 'fired', 'done', 'snoozed'] as const;
export type ReminderState = (typeof REMINDER_STATES)[number];

/** States the M02 scheduler (and the dashboard's "reminders due" list) treats as still open. */
export const OPEN_REMINDER_STATES: readonly ReminderState[] = ['pending', 'fired', 'snoozed'];
/** States the scheduler will fire (LLD Rules: "every 5 minutes, fire reminders with due_at <= now"). */
export const FIRABLE_REMINDER_STATES: readonly ReminderState[] = ['pending', 'snoozed'];

export interface ReminderRow {
  id: string;
  account_id: string;
  entry_id: string;
  due_at: Date;
  kind: string;
  state: ReminderState;
  created_at: Date;
  updated_at: Date;
}

export interface Reminder {
  id: Id<'reminder'>;
  accountId: Id<'account'>;
  entryId: Id<'shortlist_entry'>;
  dueAt: Date;
  kind: string;
  state: ReminderState;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReminderDto {
  id: string;
  entryId: string;
  companyId: string | null;
  dueAt: string;
  kind: string;
  state: ReminderState;
}

// ---- notification ----------------------------------------------------------------------------

export interface NotificationRow {
  id: string;
  account_id: string;
  kind: string;
  title_key: string;
  params: Record<string, unknown>;
  company_id: string | null;
  read_at: Date | null;
  created_at: Date;
}

export interface Notification {
  id: Id<'notification'>;
  accountId: Id<'account'>;
  kind: string;
  titleKey: string;
  params: Record<string, unknown>;
  companyId: Id<'company'> | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationDto {
  id: string;
  kind: string;
  titleKey: string;
  params: Record<string, unknown>;
  companyId: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationListDto {
  items: NotificationDto[];
  nextCursor: string | null;
}

// ---- notify_pref -----------------------------------------------------------------------------

export interface NotifyPrefRow {
  account_id: string;
  email: boolean;
  whatsapp: boolean;
  updated_at: Date;
}

export interface NotifyPrefs {
  email: boolean;
  whatsapp: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = Object.freeze({ email: false, whatsapp: false });

// ---- IF-41b notify() input ---------------------------------------------------------------------

/**
 * Known notification kinds this module emits itself (LLD Rules / M50's approved template names
 * `reminder_due_v1` and `saved_search_hits_v1` — the WhatsApp template family this module's
 * `kind` doubles as, once M50 exists). Callers other than this module's own scheduler (M42, M45,
 * M20 via EV-05, M31) may pass any other slug; `notify()` does not restrict `kind` to this list
 * (LLD's literal schema for serving.notification.kind carries no check constraint).
 */
export const NOTIFY_KIND_REMINDER_DUE = 'reminder_due';
export const NOTIFY_TITLE_KEY_REMINDER_DUE = 'notify.reminder_due';

export interface NotifyInput {
  kind: string;
  titleKey: string;
  params?: Record<string, unknown>;
  companyId?: string;
}

// ---- IF-41c dashboard ----------------------------------------------------------------------------

export interface DashboardBalanceDto {
  available: number;
  held: number;
}

export interface DashboardDto {
  pipelineCounts: Record<string, number>;
  remindersDue: ReminderDto[];
  /**
   * [deviation: LLD M41 — "new saved-search hits (once M45 exists)". M45 (Saved searches and
   * alerts) is not built yet, so this is always `[]` until M45 lands and this module is wired to
   * its hit feed; the field's shape (list of {savedSearchId, companyId, foundAt}) is a forward
   * guess at M45's serving.saved_search_hit row, not a contract M45 has to honour.]
   */
  savedSearchHits: Array<{ savedSearchId: string; companyId: string; foundAt: string }>;
  balance: DashboardBalanceDto;
}
