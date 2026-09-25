/**
 * M04 — wording rules shared by the trust and coverage components (design §3.3, REQ-028 support).
 * Pure functions: no React, so they are unit-tested and reused by M37/M39 audits.
 */
import { TRUST_CHECK_IDS, type TrustCheckDto, type TrustResultDto } from './dto.js';

/** The same pattern M24's unit test greps for. Trust UI must never render these words. */
export const FORBIDDEN_TRUST_WORDING = /verified|genuine|guaranteed/i;

export function containsForbiddenTrustWording(text: string): boolean {
  return FORBIDDEN_TRUST_WORDING.test(text);
}

export class ForbiddenWordingError extends Error {
  constructor(readonly text: string) {
    super(`Trust wording contains a forbidden word: "${text}"`);
    this.name = 'ForbiddenWordingError';
  }
}

/**
 * Returns `text` unless it contains forbidden wording. Outside production this throws, so a bad
 * M37 string fails tests and previews loudly; in production the neutral fallback is shown instead.
 */
export function guardTrustText(text: string, fallback: string, env: string | undefined = process.env.NODE_ENV): string {
  if (!containsForbiddenTrustWording(text)) return text;
  if (env !== 'production') throw new ForbiddenWordingError(text);
  return containsForbiddenTrustWording(fallback) ? '' : fallback;
}

/** Known checks first in M24 order, then any others in the order received. */
export function orderTrustChecks(checks: readonly TrustCheckDto[]): TrustCheckDto[] {
  const rank = (id: string): number => {
    const idx = (TRUST_CHECK_IDS as readonly string[]).indexOf(id);
    return idx === -1 ? TRUST_CHECK_IDS.length : idx;
  };
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => rank(a.check.id) - rank(b.check.id) || a.index - b.index)
    .map((entry) => entry.check);
}

/** "Checks passed: X of Y" counts. */
export function trustCounts(result: TrustResultDto): { passed: number; total: number } {
  return {
    passed: result.checks.filter((c) => c.outcome === 'pass').length,
    total: result.checks.length,
  };
}

const COUNTRY_LEVEL_SUFFIX = '.country_level';

/**
 * M15 appends ".country_level" to explanation keys for the country fallback row. The catalogue
 * cannot hold both "coverage.limited" and "coverage.limited.country_level", so the suffix is
 * stripped and rendered as a separate note.
 */
export function splitCoverageKey(explanationKey: string): { key: string; countryLevel: boolean } {
  if (explanationKey.endsWith(COUNTRY_LEVEL_SUFFIX)) {
    return { key: explanationKey.slice(0, -COUNTRY_LEVEL_SUFFIX.length), countryLevel: true };
  }
  return { key: explanationKey, countryLevel: false };
}

/** Keys that the UI builds from data must look like keys before they reach t(). */
export function isSafeKeySegment(value: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(value);
}

export function isSafeMessageKey(value: string): boolean {
  return value.split('.').every((part) => part.length > 0 && isSafeKeySegment(part));
}
