/**
 * M15 Coverage matrix — TS public API (read-only, IF-15a). Other modules import ONLY from this file.
 * Data side of REQ-012.
 *
 * coverage(country, hsHeading) — Strong / Partial / Limited for a country × HS heading, falling back
 * to the country-level row (key suffixed `.country_level`) and then to a synthetic Limited cell.
 *
 * The matrix is computed by the Python knowledge plane (py/kp/m15_coverage): per cell on EV-05
 * (debounced 5 min), nightly at 02:00 IST, and at the end of each M21 run.
 */
export {
  COUNTRY_FALLBACK,
  COUNTRY_LEVEL_SUFFIX,
  COVERAGE_KEYS,
  EV_DISCOVERY_COMPLETED,
  FRESH_DAYS,
  PARTIAL_MIN_FRESH,
  RECOMPUTE_ALL_JOB,
  RECOMPUTE_CELL_JOB,
  RULE_V,
  STRONG_MIN_FRESH,
} from './types.js';
export type { CoverageCell, CoverageCellRecord, CoverageLevel, CoverageRepo } from './types.js';
export {
  coverage,
  normalizeCountry,
  normalizeHeading,
  selectCell,
  setCoverageRepoForTesting,
  syntheticLimited,
  toCoverageCell,
} from './coverage.js';
export { pgCoverageRepo } from './repo.js';
