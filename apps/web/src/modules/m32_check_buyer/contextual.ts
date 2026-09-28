/**
 * M32 — IF-32b `evaluateContextual(profile)`. Used two ways: (1) M27 registers this module as its
 * `redFlags` provider (LLD M27: "Red flags come from M32.evaluateContextual(profile)"), so red
 * flags show up in context on a known company's trust checklist; (2) service.ts reuses the same
 * `domain_age` derivation for the ad hoc `/api/check` path (rules.ts's `domainSignals.newDomain`).
 *
 * Unlike evaluateRedFlags() (raw free-text input), a ProfileDoc never carries messageText, a raw
 * contact email or a page-level domain-age reading of its own — so only three of the seven rules
 * can ever fire here:
 *   - name_domain_mismatch: computed directly from `profile.name` / `profile.website` (both are
 *     already on the doc — no free-text messageText needed for this one).
 *   - freemail / new_domain: contacts and domain signals are pre-reveal (M29) and not on the
 *     public projection, so these are derived from M24's own `corporate_email` / `domain_age`
 *     rollup checks already carried in `profile.trust.checks`, the same signal IF-24b's ad hoc RPC
 *     would have produced for the same subject. [deviation: LLD M32 states these rules literally
 *     ("the email domain is on the free-mail list", "domain age < 180 days"); ProfileDoc does not
 *     expose either raw fact, so the contextual reading reuses M24's already-computed verdict
 *     instead of re-deriving it from data M32 cannot see.]
 * advance_fee / cert_fee_trap / urgent_large_order / sample_only never fire here: they are
 * messageText-only rules and a profile has no free text to run them on.
 */
import type { ProfileDoc } from '../m10_policy/index.js';
import { hasNameDomainMismatch, makeRedFlag } from './rules.js';
import type { RedFlag } from './types.js';

interface RawTrustCheck {
  id?: unknown;
  outcome?: unknown;
  explanation_key?: unknown;
}

function trustChecks(profile: ProfileDoc): RawTrustCheck[] {
  const raw = profile.trust?.checks;
  return Array.isArray(raw) ? (raw as RawTrustCheck[]) : [];
}

function checkOutcome(checks: readonly RawTrustCheck[], id: string): { outcome: string; explanationKey: string } | undefined {
  const row = checks.find((c) => c.id === id);
  if (!row) return undefined;
  return { outcome: typeof row.outcome === 'string' ? row.outcome : 'unknown', explanationKey: typeof row.explanation_key === 'string' ? row.explanation_key : '' };
}

/** Pure (given the doc): no I/O, no M09/M24 calls of its own. */
export function evaluateContextual(profile: ProfileDoc): RedFlag[] {
  const out: RedFlag[] = [];
  const checks = trustChecks(profile);

  const domainAge = checkOutcome(checks, 'domain_age');
  if (domainAge?.outcome === 'fail') out.push(makeRedFlag('new_domain'));

  const corpEmail = checkOutcome(checks, 'corporate_email');
  if (corpEmail?.outcome === 'fail' && corpEmail.explanationKey.includes('freemail')) out.push(makeRedFlag('freemail'));

  if (hasNameDomainMismatch(profile.name, profile.website ?? undefined, undefined)) out.push(makeRedFlag('name_domain_mismatch'));

  return out;
}
