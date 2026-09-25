/**
 * M01 — vendor budget alerts (LLD M01 Rules).
 *
 * An hourly job (scheduled by M02) calls runBudgetCheck(). For each vendor in
 * platform.budget it sums this UTC month's cost_event rows and:
 *   - at or above alert_pct of monthly_limit → raises an alert (once per vendor, month and level);
 *   - at or above 100 %                       → sets Redis flag `budget:exceeded:<vendor>`.
 * Connectors call assertVendorBudget(vendor) before spending; when the flag is set it throws
 * UPSTREAM_UNAVAILABLE so spending stops and callers degrade.
 */
import { monthToDateSpend } from './cost.js';
import { systemDb } from './db.js';
import { AppError } from './errors.js';
import { log } from './logging.js';
import { getRedis } from './redis.js';

export const BUDGET_EXCEEDED_PREFIX = 'budget:exceeded:';
const ALERTED_PREFIX = 'budget:alerted:';

export interface BudgetRow {
  vendor: string;
  monthlyLimitMicrosInr: bigint | null;
  alertPct: number;
}

export type BudgetLevel = 'ok' | 'alert' | 'exceeded';

export interface BudgetStatus {
  vendor: string;
  spentMicrosInr: bigint;
  limitMicrosInr: bigint | null;
  pctUsed: number | null;
  level: BudgetLevel;
}

export interface BudgetAlert {
  vendor: string;
  level: Exclude<BudgetLevel, 'ok'>;
  spentMicrosInr: bigint;
  limitMicrosInr: bigint;
  pctUsed: number;
  month: string;
}

export type BudgetAlertSink = (a: BudgetAlert) => Promise<void> | void;

/** Default sink: structured error log, which the log pipeline routes to on-call alerting. */
let alertSink: BudgetAlertSink = (a) => {
  log.error(
    {
      alert: 'vendor_budget',
      vendor: a.vendor,
      level: a.level,
      spentMicrosInr: a.spentMicrosInr.toString(),
      limitMicrosInr: a.limitMicrosInr.toString(),
      pctUsed: a.pctUsed,
      month: a.month,
    },
    `vendor budget ${a.level}: ${a.vendor} at ${a.pctUsed.toFixed(1)}%`,
  );
};

export function setBudgetAlertSink(s: BudgetAlertSink): void {
  alertSink = s;
}

/** Pure classification; exported for tests. Integer maths only (no floats on money). */
export function classifyBudget(spent: bigint, limit: bigint | null, alertPct: number): { level: BudgetLevel; pctUsed: number | null } {
  if (limit === null || limit <= 0n) return { level: 'ok', pctUsed: null };
  // basis points of the limit used, computed in bigint.
  const bp = (spent * 10_000n) / limit;
  const pctUsed = Number(bp) / 100;
  if (spent >= limit) return { level: 'exceeded', pctUsed };
  const pct = BigInt(Math.max(0, Math.min(100, Math.trunc(alertPct))));
  if (spent * 100n >= limit * pct) return { level: 'alert', pctUsed };
  return { level: 'ok', pctUsed };
}

function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Seconds until the start of next UTC month plus one hour of slack. */
function secondsToMonthEnd(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000) + 3600);
}

export async function loadBudgets(): Promise<BudgetRow[]> {
  const rows = (await systemDb('m01.budget.load')
    .selectFrom('platform.budget')
    .select(['vendor', 'monthly_limit_micros_inr', 'alert_pct'])
    .execute()) as Array<{ vendor: string; monthly_limit_micros_inr: string | number | null; alert_pct: number | null }>;
  return rows.map((r) => ({
    vendor: r.vendor,
    monthlyLimitMicrosInr: r.monthly_limit_micros_inr === null ? null : BigInt(r.monthly_limit_micros_inr),
    alertPct: r.alert_pct ?? 80,
  }));
}

/** The hourly job body. Returns the status of every budgeted vendor. */
export async function runBudgetCheck(now: Date = new Date()): Promise<BudgetStatus[]> {
  const [budgets, spend] = await Promise.all([loadBudgets(), monthToDateSpend(now)]);
  const redis = getRedis();
  const month = monthKey(now);
  const ttl = secondsToMonthEnd(now);
  const out: BudgetStatus[] = [];

  for (const b of budgets) {
    const spent = spend.get(b.vendor) ?? 0n;
    const { level, pctUsed } = classifyBudget(spent, b.monthlyLimitMicrosInr, b.alertPct);
    out.push({ vendor: b.vendor, spentMicrosInr: spent, limitMicrosInr: b.monthlyLimitMicrosInr, pctUsed, level });

    const flagKey = BUDGET_EXCEEDED_PREFIX + b.vendor;
    if (level === 'exceeded') {
      await redis.set(flagKey, month, 'EX', ttl);
    } else {
      // Limit raised or new month: lift the stop.
      await redis.del(flagKey);
    }

    if (level !== 'ok' && b.monthlyLimitMicrosInr !== null && pctUsed !== null) {
      // Alert once per vendor, month and level.
      const first = await redis.set(`${ALERTED_PREFIX}${b.vendor}:${month}:${level}`, '1', 'EX', ttl, 'NX');
      if (first !== null) {
        try {
          await alertSink({ vendor: b.vendor, level, spentMicrosInr: spent, limitMicrosInr: b.monthlyLimitMicrosInr, pctUsed, month });
        } catch (err) {
          log.error({ err, vendor: b.vendor }, 'budget alert sink failed');
        }
      }
    }
  }
  return out;
}

export async function isBudgetExceeded(vendor: string): Promise<boolean> {
  return (await getRedis().get(BUDGET_EXCEEDED_PREFIX + vendor)) !== null;
}

/**
 * Connectors call this before a paid vendor call. Throws UPSTREAM_UNAVAILABLE when the
 * vendor's monthly budget is exhausted.
 *
 * If Redis itself is unreachable we fail OPEN (log and allow the call): the budget job is a
 * spend brake, and treating a cache outage as "every vendor exhausted" would take the whole
 * product down. Month-to-date overspend in that window is bounded by the hourly job.
 */
export async function assertVendorBudget(vendor: string): Promise<void> {
  let exceeded: boolean;
  try {
    exceeded = await isBudgetExceeded(vendor);
  } catch (err) {
    log.error({ err, vendor }, 'budget flag check failed; allowing call');
    return;
  }
  if (exceeded) {
    throw new AppError('UPSTREAM_UNAVAILABLE', `${vendor} is temporarily unavailable`, { vendor, reason: 'budget_exceeded' });
  }
}
