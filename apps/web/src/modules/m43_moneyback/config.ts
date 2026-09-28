/**
 * M43 — tunables (LLD M43: "only within money_back_days = 7 [tunable, to match the M37 policy
 * page]").
 *
 * [deviation: the LLD ties this tunable to "the M37 policy page" (the public `/refund-policy`
 * content page), but M37's IF-37a exposes no API for a module to read or register a numeric
 * tunable that its Markdown content could interpolate (M37's own price-token mechanism,
 * `{{price:reveal}}`, only resolves IF-28c price-catalogue entries, not arbitrary module
 * tunables). M43 therefore owns `windowDays` as its own tunable, the same way M28 owns
 * `free.monthly_credits` and M30 owns `refunds_unconfirmed_per_month`; keeping the number on the
 * `/refund-policy` page in sync with `M43_MONEY_BACK_WINDOW_DAYS` is an operational discipline
 * (and a natural target for M37's own "no hardcoded numbers" build check, once/if that check is
 * extended to cover module tunables), not something this module can enforce at build time.]
 */
import { AppError } from '../m01_platform/index.js';

export interface MoneyBackConfig {
  /** Days from the first captured payment within which a money-back request is eligible. */
  windowDays: number;
}

const DEFAULT_CONFIG: MoneyBackConfig = {
  windowDays: 7,
};

let config: MoneyBackConfig = { ...DEFAULT_CONFIG };

export function setMoneyBackConfig(patch: Partial<MoneyBackConfig>): MoneyBackConfig {
  const next = { ...config, ...patch };
  if (!Number.isInteger(next.windowDays) || next.windowDays < 1) {
    throw new AppError('VALIDATION', 'windowDays must be a positive integer');
  }
  config = next;
  return config;
}

/** Reads `M43_MONEY_BACK_WINDOW_DAYS`. */
export function loadMoneyBackConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MoneyBackConfig {
  const raw = env.M43_MONEY_BACK_WINDOW_DAYS;
  const windowDays = raw !== undefined && raw.trim() !== '' && Number.isInteger(Number(raw)) ? Number(raw) : DEFAULT_CONFIG.windowDays;
  return setMoneyBackConfig({ windowDays });
}

export function moneyBackConfig(): MoneyBackConfig {
  return config;
}

/** Test hook. */
export function resetMoneyBackConfigForTesting(): void {
  config = { ...DEFAULT_CONFIG };
}
