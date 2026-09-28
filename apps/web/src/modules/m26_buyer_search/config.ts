/**
 * M26 — tunable settings (LLD M26 Rules).
 *
 * `discoveryReleasedCountries` mirrors M20's `/config/discovery_released.yaml` (HLD OQ9 precision
 * bar): "M26 shows web-found rows only for (country) values listed there... until then, results
 * are stored but not served." M20's knowledge plane (Python) reads that YAML file directly. There
 * is no established TS pattern in this codebase for reading YAML at runtime (every other TS
 * tunable — M05, M07, M15 — is env-driven), so the released list is read the same way here, from
 * an env var, defaulting to none released (the safe default: nothing web-only is shown until an
 * operator opts a country in). [deviation: the LLD names a YAML file; this reads
 * M26_DISCOVERY_RELEASED_COUNTRIES instead, for consistency with every other TS tunable and to
 * avoid adding a YAML parser dependency for a single flat list.]
 */
export interface BuyerSearchConfig {
  /** REQ-051 / LLD M26 rule: "More than 10 → VALIDATION." */
  maxCountries: number;
  /** Product codes accepted per request; the LLD's default is a single heading from the workspace. */
  maxHsHeadings: number;
  /** LLD M26 rule: "at most 100 characters are accepted." */
  maxKeywordLength: number;
  /** `lowConfidence = strongest evidence confidence < threshold OR source type is website only` [tunable]. */
  lowConfidenceThreshold: number;
  /** Discovery trigger threshold: `total_in_country < this` [LLD M26 rule]. */
  discoveryMinCompanies: number;
  /** UI poll interval for GET /api/buyers/discovery-status [LLD: "polled every 5 s"]. */
  discoveryPollIntervalSec: number;
  /** UI poll ceiling [LLD: "for at most 3 minutes"]. */
  discoveryPollMaxSec: number;
  /** Countries whose web-discovery rows have cleared the precision bar (HLD OQ9). */
  discoveryReleasedCountries: ReadonlySet<string>;
}

const DEFAULTS: Omit<BuyerSearchConfig, 'discoveryReleasedCountries'> = Object.freeze({
  maxCountries: 10,
  maxHsHeadings: 5,
  maxKeywordLength: 100,
  lowConfidenceThreshold: 0.6,
  discoveryMinCompanies: 10,
  discoveryPollIntervalSec: 5,
  discoveryPollMaxSec: 180,
});

const COUNTRY_RE = /^[A-Z]{2}$/;

function parseCountrySet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => COUNTRY_RE.test(c)),
  );
}

function positiveInt(v: string | undefined, fallback: number, max?: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return max !== undefined ? Math.min(n, max) : n;
}

function fraction(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export function loadBuyerSearchConfig(env: Record<string, string | undefined> = process.env): BuyerSearchConfig {
  current = {
    maxCountries: positiveInt(env.M26_MAX_COUNTRIES, DEFAULTS.maxCountries, 10),
    maxHsHeadings: positiveInt(env.M26_MAX_HS_HEADINGS, DEFAULTS.maxHsHeadings),
    maxKeywordLength: positiveInt(env.M26_MAX_KEYWORD_LENGTH, DEFAULTS.maxKeywordLength, 100),
    lowConfidenceThreshold: fraction(env.M26_LOW_CONFIDENCE_THRESHOLD, DEFAULTS.lowConfidenceThreshold),
    discoveryMinCompanies: positiveInt(env.M26_DISCOVERY_MIN_COMPANIES, DEFAULTS.discoveryMinCompanies),
    discoveryPollIntervalSec: positiveInt(env.M26_DISCOVERY_POLL_INTERVAL_SEC, DEFAULTS.discoveryPollIntervalSec),
    discoveryPollMaxSec: positiveInt(env.M26_DISCOVERY_POLL_MAX_SEC, DEFAULTS.discoveryPollMaxSec),
    discoveryReleasedCountries: parseCountrySet(env.M26_DISCOVERY_RELEASED_COUNTRIES),
  };
  return current;
}

// Lazily computed on first use (like M05's identityConfig()) rather than at module-evaluation
// time, so a self-referencing initial load does not run before `current` is declared.
let current: BuyerSearchConfig | undefined;

export function buyerSearchConfig(): BuyerSearchConfig {
  if (!current) current = loadBuyerSearchConfig();
  return current;
}

/** For tests. */
export function setBuyerSearchConfig(patch: Partial<BuyerSearchConfig>): void {
  current = { ...buyerSearchConfig(), ...patch };
}

export function isDiscoveryReleased(country: string): boolean {
  return buyerSearchConfig().discoveryReleasedCountries.has(country);
}
