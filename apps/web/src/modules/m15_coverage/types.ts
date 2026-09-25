/**
 * M15 — types and RULE_V=1 constants shared by the IF-15a read path. The matrix itself is computed by
 * the knowledge plane (py/kp/m15_coverage); these constants mirror py/kp/m15_coverage/rules.py.
 */
import type { CoverageCellDto, CoverageLabelValue } from '../m04_ui/index.js';

export const RULE_V = 1;
export const FRESH_DAYS = 180;
export const STRONG_MIN_FRESH = 50;
export const PARTIAL_MIN_FRESH = 10;

/** hs_heading of the country-level fallback row. */
export const COUNTRY_FALLBACK = '*';
export const COUNTRY_LEVEL_SUFFIX = '.country_level';

export const COVERAGE_KEYS = {
  strongCustoms: 'coverage.strong.customs',
  partialWebOnly: 'coverage.partial.web_only',
  partialFew: 'coverage.partial.few',
  limited: 'coverage.limited',
} as const;

export const RECOMPUTE_CELL_JOB = 'm15.recompute_cell';
export const RECOMPUTE_ALL_JOB = 'm15.recompute_all';
/** EV-05 DiscoveryCompleted, emitted by M20 and handled by the knowledge plane. */
export const EV_DISCOVERY_COMPLETED = 'discovery.completed';

/** Where the returned cell came from. */
export type CoverageLevel = 'heading' | 'country' | 'none';

/** IF-15a result: the M04 DTO plus the underlying counts. */
export interface CoverageCell extends CoverageCellDto {
  label: CoverageLabelValue;
  level: CoverageLevel;
  sourceTypes: string[];
  companyCount: number;
  freshCompanyCount: number;
  ruleVersion: number;
  /** ISO timestamp; null for the synthetic limited cell. */
  computedAt?: string;
}

/** knowledge.coverage_cell as returned by the driver. */
export interface CoverageCellRecord {
  country: string;
  hs_heading: string;
  source_types: string[] | null;
  company_count: number | string;
  fresh_company_count: number | string;
  label: string;
  explanation_key: string;
  params: unknown;
  rule_version: number | string;
  computed_at: Date | string | null;
}

export interface CoverageRepo {
  /** The heading row and the country fallback row ('*'), whichever exist. */
  cellsFor(country: string, hsHeading: string): Promise<CoverageCellRecord[]>;
}
