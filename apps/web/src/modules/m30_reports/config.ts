/**
 * M30 — tunables (LLD M30 Rules).
 */
import { AppError } from '../m01_platform/index.js';

export interface ReportsConfig {
  /** LLD M30: "Reports are rate-limited to 30 per account per day." [tunable] */
  reportsPerAccountPerDay: number;
  /** LLD M30: "refunds_unconfirmed_per_month = 3 [tunable]." */
  refundsUnconfirmedPerMonth: number;
  /**
   * How long a report may sit in `reverifying` before it is treated the same as an M25
   * `ContactVerified`/`unknown` outcome (LLD: "if M25 reports unknown after 24 h"). [tunable]
   */
  reverifyTimeoutHours: number;
}

const DEFAULT_CONFIG: ReportsConfig = {
  reportsPerAccountPerDay: 30,
  refundsUnconfirmedPerMonth: 3,
  reverifyTimeoutHours: 24,
};

let config: ReportsConfig = { ...DEFAULT_CONFIG };

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

export function setReportsConfig(patch: Partial<ReportsConfig>): ReportsConfig {
  const next = { ...config, ...patch };
  if (!Number.isInteger(next.reportsPerAccountPerDay) || next.reportsPerAccountPerDay < 1) {
    throw new AppError('VALIDATION', 'reportsPerAccountPerDay must be a positive integer');
  }
  if (!Number.isInteger(next.refundsUnconfirmedPerMonth) || next.refundsUnconfirmedPerMonth < 0) {
    throw new AppError('VALIDATION', 'refundsUnconfirmedPerMonth must be a non-negative integer');
  }
  if (!Number.isInteger(next.reverifyTimeoutHours) || next.reverifyTimeoutHours < 1) {
    throw new AppError('VALIDATION', 'reverifyTimeoutHours must be a positive integer');
  }
  config = next;
  return config;
}

/** Reads M30_REPORTS_PER_DAY, M30_REFUNDS_UNCONFIRMED_PER_MONTH, M30_REVERIFY_TIMEOUT_HOURS. */
export function loadReportsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReportsConfig {
  return setReportsConfig({
    reportsPerAccountPerDay: envInt('M30_REPORTS_PER_DAY') ?? DEFAULT_CONFIG.reportsPerAccountPerDay,
    refundsUnconfirmedPerMonth: envInt('M30_REFUNDS_UNCONFIRMED_PER_MONTH') ?? DEFAULT_CONFIG.refundsUnconfirmedPerMonth,
    reverifyTimeoutHours: envInt('M30_REVERIFY_TIMEOUT_HOURS') ?? DEFAULT_CONFIG.reverifyTimeoutHours,
  });
}

export function reportsConfig(): ReportsConfig {
  return config;
}

/** Test hook. */
export function resetReportsConfigForTesting(): void {
  config = { ...DEFAULT_CONFIG };
}
