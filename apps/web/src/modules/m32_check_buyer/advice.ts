/**
 * M32 — "gives advice on next steps" (LLD M32 module summary). Pure: turns a trust level, a
 * sanctions result and the triggered red flags into an ordered, de-duplicated list of M37 wording
 * keys (`advice.*`); the actual copy is rendered elsewhere, same convention as `trust.*`/`redFlag.*`.
 */
import type { RedFlag, SanctionsResultOrUnknown, TrustAdhocResultDto } from './types.js';

export function buildAdviceKeys(trustLevel: TrustAdhocResultDto['level'], sanctions: SanctionsResultOrUnknown, redFlags: readonly RedFlag[]): string[] {
  const keys: string[] = [];

  if (sanctions === 'hit' || sanctions === 'possible') keys.push(`advice.sanctions.${sanctions}`);

  for (const f of redFlags) keys.push(`advice.redFlag.${f.id}`);

  if (redFlags.some((f) => f.severity === 'high')) {
    keys.push('advice.highRisk');
  } else if (trustLevel === 'low') {
    keys.push('advice.trust.low');
  } else if (redFlags.length > 0 || trustLevel === 'unknown') {
    keys.push('advice.trust.unknown');
  } else if (trustLevel === 'medium') {
    keys.push('advice.trust.medium');
  } else if (trustLevel === 'high') {
    keys.push('advice.trust.high');
  }

  keys.push('advice.general');

  return [...new Set(keys)];
}
