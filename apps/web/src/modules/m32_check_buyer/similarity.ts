/**
 * M32 — name/domain token similarity for the `name_domain_mismatch` red flag (LLD M32 rule:
 * "token similarity between the name and the domain < 0.3"). Pure, no I/O.
 *
 * The domain is reduced to its registrable label (e.g. "acme-exports.co.in" -> "acme exports"),
 * generic business words are dropped from both sides, and similarity is the Dice coefficient over
 * the remaining word tokens (falling back to character bigrams when a side has no word tokens
 * left, e.g. a one-word domain label like "acmex").
 */
import { GENERIC_DOMAIN_WORDS } from './config.js';

function wordTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !GENERIC_DOMAIN_WORDS.has(t));
}

function bigrams(raw: string): Set<string> {
  const s = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function diceOverSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return a.size === 0 && b.size === 0 ? 1 : 0;
  let common = 0;
  for (const x of a) if (b.has(x)) common += 1;
  return (2 * common) / (a.size + b.size);
}

/** The registrable domain's first label, with the TLD/suffix removed (e.g. "acme.co.in" -> "acme"). */
export function domainLabel(registrableDomain: string): string {
  const first = registrableDomain.split('.', 1)[0] ?? registrableDomain;
  return first;
}

/** Dice similarity in [0, 1] between a company name and a (registrable) domain. */
export function nameDomainSimilarity(name: string, registrableDomain: string): number {
  const label = domainLabel(registrableDomain);
  const nameWords = new Set(wordTokens(name));
  const domainWords = new Set(wordTokens(label.replace(/-/g, ' ')));
  const wordScore = diceOverSets(nameWords, domainWords);
  if (nameWords.size > 0 && domainWords.size > 0) return wordScore;
  // One (or both) sides collapsed to nothing after stripping generic words (e.g. the domain
  // label is a single run-on token like "acmeexports"): fall back to character bigrams so a
  // clearly-related single-token domain is not scored as a total mismatch.
  return diceOverSets(bigrams(name), bigrams(label));
}
