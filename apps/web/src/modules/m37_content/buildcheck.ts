/**
 * M37 — the build check LLD M37 requires: "A build check fails on any hardcoded '₹' or 'credit'
 * number inside the promise, refund and pricing pages." Every number a visitor sees there must
 * come from `{{price:...}}` (priceTokens.ts → IF-28c), never from literal prose.
 *
 * This runs as a unit test (content.test.ts) against the real content tree, the same way M04's
 * `containsForbiddenTrustWording` is unit-tested rather than run as a separate CI script — there
 * is no shell in this environment to add a standalone script step, and a failing test blocks the
 * build exactly the same way.
 */
import { stripPriceTokens } from './priceTokens.js';
import type { ContentSection, ContentSourceDocument } from './types.js';
import { PRICE_SENSITIVE_SECTIONS } from './types.js';

const RUPEE_RE = /₹/;
const CREDIT_NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?\s*credits?\b/i;
const CURRENCY_WORD_RE = /\b(?:rs\.?|inr)\s?\d/i;

export interface PriceLintViolation {
  locale: string;
  section: ContentSection;
  slug: string;
  reason: 'rupee_literal' | 'credit_number_literal' | 'currency_word_literal';
  snippet: string;
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + length + 20);
  return text.slice(start, end).trim();
}

/** Pure: scans one document's raw body (front matter and `{{price:...}}` tokens already excluded
 * by the caller / stripPriceTokens) for a hardcoded price. Only applies to the LLD's three
 * price-sensitive sections; other sections may freely mention "credit" in prose ("we give you the
 * benefit of the doubt", etc.) without tripping this check. */
export function lintDocumentForHardcodedPrices(doc: Pick<ContentSourceDocument, 'locale' | 'section' | 'slug' | 'rawBody'>): PriceLintViolation[] {
  if (!PRICE_SENSITIVE_SECTIONS.includes(doc.section)) return [];
  const text = stripPriceTokens(doc.rawBody);
  const violations: PriceLintViolation[] = [];

  const rupee = RUPEE_RE.exec(text);
  if (rupee) violations.push({ locale: doc.locale, section: doc.section, slug: doc.slug, reason: 'rupee_literal', snippet: snippetAround(text, rupee.index, 1) });

  const creditNum = CREDIT_NUMBER_RE.exec(text);
  if (creditNum) {
    violations.push({
      locale: doc.locale,
      section: doc.section,
      slug: doc.slug,
      reason: 'credit_number_literal',
      snippet: snippetAround(text, creditNum.index, creditNum[0].length),
    });
  }

  const currencyWord = CURRENCY_WORD_RE.exec(text);
  if (currencyWord) {
    violations.push({
      locale: doc.locale,
      section: doc.section,
      slug: doc.slug,
      reason: 'currency_word_literal',
      snippet: snippetAround(text, currencyWord.index, currencyWord[0].length),
    });
  }

  return violations;
}

export function lintAllForHardcodedPrices(
  docs: readonly Pick<ContentSourceDocument, 'locale' | 'section' | 'slug' | 'rawBody'>[],
): PriceLintViolation[] {
  return docs.flatMap((doc) => lintDocumentForHardcodedPrices(doc));
}

// ---------------------------------------------------------------------------------------------
// Review-before-prod gate — LLD M37: "Trust wording keys must have reviewedAt set before prod
// deploy; CI enforces this for the trust.* keys." Trust wording itself lives in M04's message
// catalogue (already shipped there, see [deviation] in service.ts), but the same governance is
// the right bar for M37's own policy pages (promise/coverage/refund-policy), which are equally
// legal/compliance sensitive. Mirrors M04 wording.ts's guardTrustText: throws outside production
// (so a missing review fails CI loudly) and only degrades — by listing the gap rather than
// blocking the whole page render — in production, where refusing to render the page at all would
// be worse than serving unreviewed-but-published copy.
// ---------------------------------------------------------------------------------------------

const REVIEW_REQUIRED_SECTIONS: readonly ContentSection[] = ['promise', 'coverage', 'refund-policy'];

export interface ReviewGapViolation {
  locale: string;
  section: ContentSection;
  slug: string;
  reason: 'missing_reviewedAt' | 'missing_reviewedBy';
}

export function findReviewGaps(
  docs: readonly Pick<ContentSourceDocument, 'locale' | 'section' | 'slug' | 'frontMatter'>[],
): ReviewGapViolation[] {
  const out: ReviewGapViolation[] = [];
  for (const doc of docs) {
    if (!REVIEW_REQUIRED_SECTIONS.includes(doc.section)) continue;
    if (!doc.frontMatter.reviewedAt) out.push({ locale: doc.locale, section: doc.section, slug: doc.slug, reason: 'missing_reviewedAt' });
    if (!doc.frontMatter.reviewedBy) out.push({ locale: doc.locale, section: doc.section, slug: doc.slug, reason: 'missing_reviewedBy' });
  }
  return out;
}

export class UnreviewedContentError extends Error {
  constructor(readonly gaps: ReviewGapViolation[]) {
    super(`${gaps.length} legal/policy content page(s) are missing reviewedBy/reviewedAt: ${gaps.map((g) => `${g.section}/${g.slug}`).join(', ')}`);
    this.name = 'UnreviewedContentError';
  }
}

/** Throws outside production; returns the gap list (for logging) in production. */
export function assertReviewedForProd(
  docs: readonly Pick<ContentSourceDocument, 'locale' | 'section' | 'slug' | 'frontMatter'>[],
  env: string | undefined = process.env.NODE_ENV,
): ReviewGapViolation[] {
  const gaps = findReviewGaps(docs);
  if (gaps.length === 0) return gaps;
  if (env !== 'production') throw new UnreviewedContentError(gaps);
  return gaps;
}
