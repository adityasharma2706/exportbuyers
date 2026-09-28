/**
 * M37 — `{{price:action[:quantity[:country]]}}` token resolution (LLD M37 rule: "Prices are
 * interpolated with `{{price:reveal}}` tokens that resolve through IF-28c at render time").
 *
 * Tokens are resolved in the raw Markdown source, before it reaches the renderer, so the
 * resulting price text still passes through the normal HTML-escaping in markdown.ts. The
 * companion `buildcheck.ts` scans the *source* (with tokens stripped) for hardcoded prices, so a
 * page can only ever show a number here by going through this resolver.
 */
import { getCatalogue, isPriceAction, quote, type PriceAction } from '../m28_credits/index.js';
import { AppError } from '../m01_platform/index.js';

export const PRICE_TOKEN_RE = /\{\{\s*price:([a-z_]+)(?::(\d+))?(?::([A-Za-z]{2}))?\s*\}\}/g;

export interface PriceToken {
  raw: string;
  action: string;
  quantity: number;
  country: string | null;
}

/** Every `{{price:...}}` token in `markdown`, for the build check and for tests. */
export function findPriceTokens(markdown: string): PriceToken[] {
  const out: PriceToken[] = [];
  for (const m of markdown.matchAll(PRICE_TOKEN_RE)) {
    out.push({
      raw: m[0],
      action: m[1]!,
      quantity: m[2] ? Number(m[2]) : 1,
      country: m[3] ? m[3].toUpperCase() : null,
    });
  }
  return out;
}

const CREDITS_FALLBACK = 'price unavailable';

function quoteOrNull(action: PriceAction, quantity: number, country: string | null): number | null {
  try {
    return quote(null, action, { quantity, country: country ?? undefined }).credits;
  } catch (e) {
    if (e instanceof AppError) return null;
    throw e;
  }
}

function formatPriceToken(action: string, quantity: number, country: string | null): string {
  if (!isPriceAction(action)) return CREDITS_FALLBACK;
  const credits = quoteOrNull(action, quantity, country);
  if (credits === null) return CREDITS_FALLBACK;
  if (credits === 0) return 'free';
  const creditsText = `${credits} ${credits === 1 ? 'credit' : 'credits'}`;
  const catalogue = getCatalogue();
  if (catalogue.inrPerCredit === null) return creditsText;
  const inr = Math.round(credits * catalogue.inrPerCredit * 100) / 100;
  const inrText = inr.toLocaleString('en-IN', { minimumFractionDigits: inr % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  return `${creditsText} (₹${inrText})`;
}

/** Replaces every `{{price:...}}` token in `markdown` with its resolved, human-readable text. An
 * unpriced or unknown action degrades to "price unavailable" rather than throwing, matching M04
 * CostBadge's own degraded state (LLD M04 edge case) — a content page must still render. */
export function resolvePriceTokens(markdown: string): string {
  return markdown.replace(PRICE_TOKEN_RE, (_whole, action: string, qty: string | undefined, country: string | undefined) =>
    formatPriceToken(action, qty ? Number(qty) : 1, country ? country.toUpperCase() : null),
  );
}

/** Removes tokens entirely (used by the build check, which must not mistake a token's own digits
 * — e.g. the `5` in `{{price:reveal_bulk_each:5}}` — for a hardcoded price). */
export function stripPriceTokens(markdown: string): string {
  return markdown.replace(PRICE_TOKEN_RE, ' ');
}
