/**
 * M32 — tunables (LLD M32 "Red-flag rules (v1)").
 *
 * [deviation: the free-mail list here duplicates M10's own `FREEMAIL_DOMAINS`
 * (m10_policy/policy.ts), which is private to that module. Same precedent as M29's crypto.ts
 * copying M05's: M32 needs the list for a rule that runs on raw input `email`, before any
 * catalogue lookup, and M10 does not export it.]
 */
export interface CheckBuyerConfig {
  /** LLD rule: "token similarity between the name and the domain < 0.3". */
  nameDomainMismatchThreshold: number;
  /** Price/allowance action id (M28 catalogue key `check_buyer`, allowance kind `check`). */
  priceAction: 'check_buyer';
  allowanceKind: 'check';
}

const DEFAULTS: CheckBuyerConfig = Object.freeze({
  nameDomainMismatchThreshold: 0.3,
  priceAction: 'check_buyer',
  allowanceKind: 'check',
});

let current: CheckBuyerConfig | undefined;

function fraction(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export function loadCheckBuyerConfig(env: Record<string, string | undefined> = process.env): CheckBuyerConfig {
  current = {
    ...DEFAULTS,
    nameDomainMismatchThreshold: fraction(env.M32_NAME_DOMAIN_MISMATCH_THRESHOLD, DEFAULTS.nameDomainMismatchThreshold),
  };
  return current;
}

export function checkBuyerConfig(): CheckBuyerConfig {
  if (!current) current = loadCheckBuyerConfig();
  return current;
}

export function setCheckBuyerConfig(patch: Partial<CheckBuyerConfig>): void {
  current = { ...checkBuyerConfig(), ...patch };
}

/** Consumer mailbox domains (mirrors M10's own list; see module doc comment above). */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'aol.com', 'rediffmail.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.de', 'mail.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com', 'zoho.com',
]);

/** Generic words stripped before a domain label is compared against a company name (rules.ts). */
export const GENERIC_DOMAIN_WORDS: ReadonlySet<string> = new Set([
  'the', 'group', 'company', 'co', 'ltd', 'limited', 'inc', 'llc', 'corp', 'corporation',
  'international', 'intl', 'global', 'trading', 'trade', 'export', 'exports', 'import', 'imports',
  'industries', 'industry', 'enterprises', 'enterprise', 'india', 'online', 'store', 'shop', 'world',
]);
