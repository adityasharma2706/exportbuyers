/**
 * M28 — tunable limits (LLD M28 Rules): the monthly free grant amount [tunable, 10], the default
 * hold TTL [300s], the unconfirmed-refund cap used by M30 [tunable, 3] and batch sizes for the
 * sweeper / monthly-grant jobs.
 */
export interface CreditsConfig {
  /** Default `hold()` TTL when the caller does not pass one. */
  defaultHoldTtlSec: number;
  /** `free.monthly_credits` — granted to every active account on the 1st at 00:05 IST. */
  freeMonthlyCredits: number;
  /** M30's `refunds_unconfirmed_per_month` cap; read here because M28 owns refund(). */
  refundsUnconfirmedPerMonth: number;
  /** Max expired holds released per sweeper run (m28.sweep_expired_holds, every minute). */
  sweepBatchSize: number;
  /** Max accounts granted per monthly-free-grant run; a run at the cap logs a warning. */
  monthlyGrantMaxAccounts: number;
}

const DEFAULTS: CreditsConfig = Object.freeze({
  defaultHoldTtlSec: 300,
  freeMonthlyCredits: 10,
  refundsUnconfirmedPerMonth: 3,
  sweepBatchSize: 500,
  monthlyGrantMaxAccounts: 200_000,
});

let current: CreditsConfig = { ...DEFAULTS };

function positiveInt(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

export function loadCreditsConfig(env: Record<string, string | undefined> = process.env): CreditsConfig {
  current = {
    defaultHoldTtlSec: positiveInt(env.M28_DEFAULT_HOLD_TTL_SEC, DEFAULTS.defaultHoldTtlSec),
    freeMonthlyCredits: positiveInt(env.M28_FREE_MONTHLY_CREDITS, DEFAULTS.freeMonthlyCredits),
    refundsUnconfirmedPerMonth: positiveInt(env.M28_REFUNDS_UNCONFIRMED_PER_MONTH, DEFAULTS.refundsUnconfirmedPerMonth),
    sweepBatchSize: positiveInt(env.M28_SWEEP_BATCH_SIZE, DEFAULTS.sweepBatchSize),
    monthlyGrantMaxAccounts: positiveInt(env.M28_MONTHLY_GRANT_MAX_ACCOUNTS, DEFAULTS.monthlyGrantMaxAccounts),
  };
  return current;
}

export function creditsConfig(): CreditsConfig {
  return current;
}

/** For tests. */
export function setCreditsConfig(patch: Partial<CreditsConfig>): void {
  current = { ...current, ...patch };
}
