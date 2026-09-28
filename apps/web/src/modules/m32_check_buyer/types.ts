/**
 * M32 — shared types (LLD M32 "Check a buyer", IF-32a/IF-32b).
 */
import type { TrustResultDto } from '../m04_ui/index.js';

export type SanctionsResultOrUnknown = 'clear' | 'possible' | 'hit' | 'unknown';

/** The seven v1 scam red-flag rules (LLD M32 "Red-flag rules (v1)"). */
export const RED_FLAG_IDS = [
  'advance_fee',
  'cert_fee_trap',
  'freemail',
  'new_domain',
  'name_domain_mismatch',
  'urgent_large_order',
  'sample_only',
] as const;
export type RedFlagId = (typeof RED_FLAG_IDS)[number];

export type RedFlagSeverity = 'high' | 'medium';

/** IF-32b: `RedFlag = {id, severity:'high'|'medium', explanationKey, guideSlug}`. */
export interface RedFlag {
  id: RedFlagId;
  severity: RedFlagSeverity;
  /** M37 wording key, e.g. "redFlag.advance_fee". */
  explanationKey: string;
  /** Slug of a help-centre guide explaining the pattern, e.g. "advance-fee-scams". */
  guideSlug: string;
}

/** What evaluateRedFlags() and evaluateContextual() take as their raw free-text input. */
export interface RedFlagRuleInput {
  name?: string | undefined;
  email?: string | undefined;
  website?: string | undefined;
  messageText?: string | undefined;
  /**
   * Domain-age signal for the `new_domain` rule. M32 has no WHOIS/registrar access of its own
   * (that lives behind M23/M24); this carries only the categorical fail the caller already
   * derived from M24's own `domain_age` check (see rules.ts doc comment for why the raw age in
   * days cannot be threaded through here).
   */
  domainSignals?: { newDomain?: boolean } | undefined;
}

// ---- wire DTOs (IF-32a) ------------------------------------------------------------------------

export interface CheckBuyerRequestDto {
  name?: string;
  email?: string;
  website?: string;
  country?: string;
  messageText?: string;
}

export interface CheckBuyerResponseDto {
  trust: TrustResultDto;
  sanctions: SanctionsResultOrUnknown;
  redFlags: RedFlag[];
  adviceKeys: string[];
  matchedCompanyId?: string;
  creditsCharged: number;
}

/** One `trust.check.<id>` outcome from IF-24b's ad hoc RPC (`RollupResult.to_dict()`). */
export interface TrustAdhocCheckDto {
  id: string;
  outcome: 'pass' | 'fail' | 'unknown';
  checkedAt: string;
  explanationKey: string;
  assertionId: string | null;
}

/** IF-24b `POST /rpc/trust/adhoc` response (`RollupResult.to_dict()`, py/kp/m24_trust/models.py). */
export interface TrustAdhocResultDto {
  level: 'high' | 'medium' | 'low' | 'unknown';
  ruleVersion: number;
  copyVersion: string;
  computedAt: string;
  checks: TrustAdhocCheckDto[];
}
