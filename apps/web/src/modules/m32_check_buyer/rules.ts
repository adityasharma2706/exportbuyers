/**
 * M32 — the scam red-flag rules engine (IF-32b `evaluateRedFlags`, LLD M32 "Red-flag rules (v1)").
 *
 * Five of the seven rules run on the raw input alone (freemail, name_domain_mismatch, and the
 * three messageText regex rules); `new_domain` cannot — M32 has no WHOIS/registrar access of its
 * own, so its signal is threaded through as `input.domainSignals.newDomain`, already derived by
 * the caller (service.ts) from M24's own `domain_age` check via the ad hoc trust RPC (IF-24b).
 * See contextual.ts for the equivalent derivation from a catalogue ProfileDoc's own trust checks.
 */
import { normalise } from '../m10_policy/index.js';
import { checkBuyerConfig, FREEMAIL_DOMAINS } from './config.js';
import { nameDomainSimilarity } from './similarity.js';
import type { RedFlag, RedFlagId, RedFlagRuleInput } from './types.js';

// ---- static per-rule metadata (severity + guide) -----------------------------------------------

const RULE_META: Record<RedFlagId, { severity: RedFlag['severity']; guideSlug: string }> = {
  advance_fee: { severity: 'high', guideSlug: 'advance-fee-scams' },
  cert_fee_trap: { severity: 'high', guideSlug: 'certification-fee-scams' },
  freemail: { severity: 'medium', guideSlug: 'freemail-contacts' },
  new_domain: { severity: 'medium', guideSlug: 'new-domains' },
  name_domain_mismatch: { severity: 'medium', guideSlug: 'name-domain-mismatch' },
  urgent_large_order: { severity: 'high', guideSlug: 'urgent-large-orders' },
  sample_only: { severity: 'medium', guideSlug: 'sample-only-requests' },
};

export function makeRedFlag(id: RedFlagId): RedFlag {
  const meta = RULE_META[id];
  return { id, severity: meta.severity, explanationKey: `redFlag.${id}`, guideSlug: meta.guideSlug };
}

// ---- messageText regex rules --------------------------------------------------------------------

const ADVANCE_FEE_RE = [
  /\b(registration|processing|membership|application|clearance|licen[cs]e)\s+fee\b/i,
  /\bpay\s+(the\s+|a\s+)?(fee|amount|deposit)\s+(before|in\s+advance|up\s*front)\b/i,
  /\b(advance|upfront|up-front)\s+payment\s+(is\s+)?required\s+before\b/i,
  /\bpay\s+(us\s+)?(first|now)\s+(and|before)\s+(we|the\s+order)\b/i,
];

const CERT_FEE_TRAP_RE = [
  /\b(certificat\w*|lab(?:oratory)?\s*test\w*|inspection|quality\s+certificat\w*)\s+(fee|charge|payment|cost)\b/i,
  /\bpay\s+(our|the|to\s+our)\s+(certification|inspection|certifying)\s+(agency|agent|body|office)\b/i,
  /\b(certification|inspection)\s+agency\s+(requires|will\s+charge|needs)\s+(a\s+)?(fee|payment)\b/i,
];

const URGENCY_RE = /\b(urgent(ly)?|immediately|right\s+away|asap|today\s+only|act\s+now|ship(ping)?\s+today|hurry)\b/i;
const LARGE_ORDER_RE = /\b(\d[\d,]{2,}\s*(units?|pieces?|pcs|tons?|tonnes?|containers?)|(usd|us\$|\$|€|£)\s*\d[\d,]{3,})\b/i;

const SAMPLE_MENTION_RE = /\b(free\s+samples?|sample\s+order|send\s+(us\s+)?(a\s+)?sample)\b/i;
const ORDER_MENTION_RE = /\b(purchase\s+order|\bpo\b|bulk\s+order|place\s+an?\s+order|payment\s+terms|contract|lc\b|letter\s+of\s+credit)\b/i;

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

/** LLD: "urgency words + large quantity or value patterns". */
function isUrgentLargeOrder(text: string): boolean {
  return URGENCY_RE.test(text) && LARGE_ORDER_RE.test(text);
}

/** LLD: "free samples requested with no order discussion". */
function isSampleOnly(text: string): boolean {
  return SAMPLE_MENTION_RE.test(text) && !ORDER_MENTION_RE.test(text);
}

// ---- freemail (LLD: "the email domain is on the free-mail list") ------------------------------

function emailDomain(email: string): string | undefined {
  try {
    return normalise('domain', email.slice(email.lastIndexOf('@') + 1));
  } catch {
    return undefined;
  }
}

export function isFreemailEmail(email: string | undefined): boolean {
  if (!email || !email.includes('@')) return false;
  const d = emailDomain(email);
  return d !== undefined && FREEMAIL_DOMAINS.has(d);
}

// ---- name_domain_mismatch -----------------------------------------------------------------------

/** The company's own site domain implied by `website`, or by `email` when it is not free-mail. */
function siteDomain(website: string | undefined, email: string | undefined): string | undefined {
  if (website && website.trim()) {
    try {
      return normalise('domain', website);
    } catch {
      /* fall through to email */
    }
  }
  if (email && email.includes('@')) {
    const d = emailDomain(email);
    if (d && !FREEMAIL_DOMAINS.has(d)) return d;
  }
  return undefined;
}

export function hasNameDomainMismatch(name: string | undefined, website: string | undefined, email: string | undefined): boolean {
  if (!name || !name.trim()) return false;
  const domain = siteDomain(website, email);
  if (!domain) return false;
  const sim = nameDomainSimilarity(name, domain);
  return sim < checkBuyerConfig().nameDomainMismatchThreshold;
}

// ---- IF-32b evaluateRedFlags ----------------------------------------------------------------

/**
 * Pure: runs every rule the given `input` has enough signal for and returns the ones that
 * triggered, in LLD table order. Never throws — a rule that cannot be evaluated (missing input)
 * is simply skipped.
 */
export function evaluateRedFlags(input: RedFlagRuleInput): RedFlag[] {
  const out: RedFlag[] = [];
  const text = input.messageText ?? '';

  if (text && matchesAny(text, ADVANCE_FEE_RE)) out.push(makeRedFlag('advance_fee'));
  if (text && matchesAny(text, CERT_FEE_TRAP_RE)) out.push(makeRedFlag('cert_fee_trap'));
  if (isFreemailEmail(input.email)) out.push(makeRedFlag('freemail'));
  if (input.domainSignals?.newDomain === true) out.push(makeRedFlag('new_domain'));
  if (hasNameDomainMismatch(input.name, input.website, input.email)) out.push(makeRedFlag('name_domain_mismatch'));
  if (text && isUrgentLargeOrder(text)) out.push(makeRedFlag('urgent_large_order'));
  if (text && isSampleOnly(text)) out.push(makeRedFlag('sample_only'));

  return out;
}
