/**
 * M41 — tunable limits. Nothing here is given a literal number by the LLD; defaults are chosen
 * to keep the scheduler and dashboard queries cheap, and are overridable per [tunable] convention.
 */
export interface NotifyConfig {
  /** Rows the `m41.fire_reminders` scheduler tick claims per run (LLD: "every 5 minutes"). */
  schedulerBatchSize: number;
  /** Cap on `remindersDue` in IF-41c's dashboard response. */
  dashboardRemindersLimit: number;
  /** Default/max page size for the in-app notification feed (`GET /api/notifications`). */
  notificationListDefaultLimit: number;
  notificationListMaxLimit: number;
}

const DEFAULTS: NotifyConfig = Object.freeze({
  schedulerBatchSize: 200,
  dashboardRemindersLimit: 50,
  notificationListDefaultLimit: 20,
  notificationListMaxLimit: 100,
});

let current: NotifyConfig = { ...DEFAULTS };

function positiveInt(v: string | undefined, fallback: number, max?: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return max !== undefined ? Math.min(n, max) : n;
}

export function loadNotifyConfig(env: Record<string, string | undefined> = process.env): NotifyConfig {
  current = {
    schedulerBatchSize: positiveInt(env.M41_SCHEDULER_BATCH_SIZE, DEFAULTS.schedulerBatchSize, 2000),
    dashboardRemindersLimit: positiveInt(env.M41_DASHBOARD_REMINDERS_LIMIT, DEFAULTS.dashboardRemindersLimit, 500),
    notificationListDefaultLimit: positiveInt(env.M41_NOTIFICATION_LIST_DEFAULT_LIMIT, DEFAULTS.notificationListDefaultLimit, 100),
    notificationListMaxLimit: positiveInt(env.M41_NOTIFICATION_LIST_MAX_LIMIT, DEFAULTS.notificationListMaxLimit, 500),
  };
  return current;
}

export function notifyConfig(): NotifyConfig {
  return current;
}

/** For tests. */
export function setNotifyConfig(patch: Partial<NotifyConfig>): void {
  current = { ...current, ...patch };
}
