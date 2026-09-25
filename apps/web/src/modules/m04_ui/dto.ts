/**
 * M04 — DTOs rendered by the IF-04a components. Shapes follow the producing modules:
 * CoverageCellDto ← M15 `knowledge.coverage_cell`; TrustResultDto ← M24 checks + rollup.
 */

export type CoverageLabelValue = 'strong' | 'partial' | 'limited';

export interface CoverageCellDto {
  country: string;
  hsHeading: string;
  label: CoverageLabelValue;
  /** e.g. coverage.strong.customs, coverage.partial.few, optionally suffixed ".country_level". */
  explanationKey: string;
  params: { count?: number; sources?: string[] } & Record<string, unknown>;
  ruleVersion?: number;
  computedAt?: string;
}

export type TrustLevel = 'high' | 'medium' | 'low' | 'unknown';
export type TrustOutcome = 'pass' | 'fail' | 'unknown';

/** The six M24 check ids, in display order. */
export const TRUST_CHECK_IDS = [
  'registered_entity',
  'website_consistent',
  'domain_age',
  'corporate_email',
  'recent_trade',
  'sanctions',
] as const;
export type TrustCheckId = (typeof TRUST_CHECK_IDS)[number];

export interface TrustCheckDto {
  id: string;
  outcome: TrustOutcome;
  checkedAt: string | null;
  /** M37 wording key explaining this outcome; optional because ad-hoc checks may omit it. */
  explanationKey?: string | null;
}

export interface TrustResultDto {
  level: TrustLevel;
  checks: TrustCheckDto[];
  ruleVersion?: number;
  copyVersion?: string;
}

export type DisclaimerKind = 'hs' | 'trust' | 'sanctions' | 'coverage';
