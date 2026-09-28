/**
 * M41 Reminders, notifications and dashboard — public API. Other modules import ONLY from this
 * file.
 *
 * IF-41a Reminders    createReminder(ctx, entryId, dueAt, kind), snooze(ctx, id, until),
 *                      complete(ctx, id). The M02 scheduler fires due reminders every 5 minutes.
 * IF-41b Notify        notify(accountId, {kind, titleKey, params, companyId?}): in-app always,
 *                      plus transactional email for accounts opted in via `notify_pref`.
 *                      Content is checked through M10's IF-10a before anything is written.
 * IF-41c Dashboard     GET /api/dashboard -> {pipelineCounts, remindersDue, savedSearchHits,
 *                      balance}, computed live.
 * Routes (see routes.ts's own header for the full list, including additions not literally in
 *   the LLD's "API:" block: /api/notifications, /api/notify-prefs, /api/reminders).
 */
export type {
  DashboardBalanceDto,
  DashboardDto,
  Notification,
  NotificationDto,
  NotificationListDto,
  NotificationRow,
  NotifyInput,
  NotifyPrefRow,
  NotifyPrefs,
  Reminder,
  ReminderDto,
  ReminderRow,
  ReminderState,
} from './types.js';
export {
  DEFAULT_NOTIFY_PREFS,
  FIRABLE_REMINDER_STATES,
  NOTIFY_KIND_REMINDER_DUE,
  NOTIFY_TITLE_KEY_REMINDER_DUE,
  OPEN_REMINDER_STATES,
  REMINDER_STATES,
} from './types.js';

export { loadNotifyConfig, notifyConfig, setNotifyConfig } from './config.js';
export type { NotifyConfig } from './config.js';

export { systemCtxFor } from './systemCtx.js';

export {
  complete,
  createReminder,
  dashboard,
  getNotifyPrefs,
  listNotificationsPage,
  markRead,
  notify,
  setNotifyPrefs,
  snooze,
} from './service.js';

export { FIRE_REMINDERS_JOB, fireDueReminders, registerNotifyJobs, resetNotifyJobsForTesting } from './jobs.js';

export { registerNotifyRoutes } from './routes.js';
export type { NotifyRouteApp, NotifyRouteReply, NotifyRouteRequest } from './routes.js';

export { NOTIFY_LABELS_EN, notifyTitleLabel } from './labels.js';
