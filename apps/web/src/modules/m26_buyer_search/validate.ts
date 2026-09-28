/**
 * M26 — request validation (IF-26a). Pure functions; no I/O.
 *
 *   parseBuyerSearchInput(body)     shape/type validation of the wire body
 *   resolveCountries / resolveHeadings   apply LLD M26's rules (≤10 countries; a 4-digit heading)
 */
import { z } from 'zod';
import { AppError } from '../m01_platform/index.js';
import { buyerSearchConfig } from './config.js';

const COUNTRY_RE = /^[A-Z]{2}$/;
const CODE_RE = /^(?:[0-9]{4}|[0-9]{6}|[0-9]{8})$/;

export const buyerSearchInputSchema = z
  .object({
    workspaceId: z.string().min(1).max(64).optional(),
    hsHeadings: z.array(z.string().min(1).max(16)).max(50).optional(),
    keyword: z.string().max(500).optional(),
    countries: z.array(z.string().min(1).max(8)).max(50).optional(),
    buyerTypes: z.array(z.string().min(1).max(64)).max(20).optional(),
    activeWithinMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]).optional(),
    minShipments12m: z.number().int().min(0).max(1_000_000).optional(),
    trustLevels: z.array(z.enum(['high', 'medium', 'low', 'unknown'])).max(4).optional(),
    contactTypes: z.array(z.string().min(1).max(32)).max(10).optional(),
    originIndia: z.boolean().optional(),
    originCompetitor: z.boolean().optional(),
    includeLogistics: z.boolean().optional(),
    sort: z.enum(['relevance', 'recency', 'volume', 'trust']).optional(),
    page: z.number().int().min(1).max(10_000).optional(),
    pageSize: z.union([z.literal(20), z.literal(50)]).optional(),
  })
  .strict();

export type BuyerSearchInput = z.infer<typeof buyerSearchInputSchema>;

/** Validates the wire body's shape. Defaulting (workspace / anonymous session) happens in service.ts. */
export function parseBuyerSearchInput(body: unknown): BuyerSearchInput {
  const r = buyerSearchInputSchema.safeParse(body ?? {});
  if (!r.success) throw new AppError('VALIDATION', 'Invalid search request', { issues: r.error.issues });
  return r.data;
}

/** A 4, 6 or 8 digit HS code reduced to its 4-digit heading. */
export function toHeading(raw: string, field = 'hsHeadings'): string {
  const digits = raw.trim().replace(/[.\s-]/g, '');
  if (!CODE_RE.test(digits)) throw new AppError('VALIDATION', 'Buyer search needs a 4, 6 or 8 digit HS code', { field });
  return digits.slice(0, 4);
}

/** Explicit `countries` from the request body: LLD M26 rule — empty → VALIDATION; >10 → VALIDATION. */
export function resolveExplicitCountries(list: readonly string[]): string[] {
  const cfg = buyerSearchConfig();
  const norm = list.map((c) => String(c).trim().toUpperCase());
  const bad = norm.find((c) => !COUNTRY_RE.test(c));
  if (bad !== undefined) throw new AppError('VALIDATION', 'countries must be ISO 3166-1 alpha-2 codes', { field: 'countries' });
  const uniq = [...new Set(norm)];
  if (uniq.length === 0) throw new AppError('VALIDATION', 'Choose at least one country', { field: 'countries' });
  if (uniq.length > cfg.maxCountries) {
    throw new AppError('VALIDATION', `Choose at most ${cfg.maxCountries} countries`, { field: 'countries', max: cfg.maxCountries });
  }
  return uniq;
}

/**
 * Default countries (workspace or anonymous-session shortlist). Truncated to the request cap
 * rather than rejected outright — a workspace may legitimately hold up to 20 (M07), more than a
 * single search request accepts [assumption: silently narrowing a default is friendlier than
 * failing every default search until the user prunes their shortlist].
 */
export function resolveDefaultCountries(list: readonly string[]): string[] {
  const cfg = buyerSearchConfig();
  const norm = [...new Set(list.map((c) => String(c).trim().toUpperCase()).filter((c) => COUNTRY_RE.test(c)))];
  return norm.slice(0, cfg.maxCountries);
}

/** Explicit `hsHeadings` from the request body. */
export function resolveExplicitHeadings(list: readonly string[]): string[] {
  const cfg = buyerSearchConfig();
  if (list.length > cfg.maxHsHeadings) {
    throw new AppError('VALIDATION', `Choose at most ${cfg.maxHsHeadings} product codes`, { field: 'hsHeadings', max: cfg.maxHsHeadings });
  }
  return [...new Set(list.map((c) => toHeading(c)))];
}

/** LLD M26 rule: "at most 100 characters are accepted." Trimmed; empty means no keyword filter. */
export function resolveKeyword(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const cfg = buyerSearchConfig();
  if (trimmed.length > cfg.maxKeywordLength) {
    throw new AppError('VALIDATION', `Keyword must be at most ${cfg.maxKeywordLength} characters`, {
      field: 'keyword',
      max: cfg.maxKeywordLength,
    });
  }
  return trimmed;
}

/** GET discovery-status query parsing. */
export function parseDiscoveryStatusQuery(rawHeading: unknown, rawCountries: unknown): { heading: string; countries: string[] } {
  if (typeof rawHeading !== 'string' || rawHeading.trim().length === 0) {
    throw new AppError('VALIDATION', 'heading is required: a 4, 6 or 8 digit HS code', { field: 'heading' });
  }
  const heading = toHeading(rawHeading, 'heading');
  const flat: string[] =
    typeof rawCountries === 'string'
      ? rawCountries.split(',')
      : Array.isArray(rawCountries)
        ? rawCountries.flatMap((c) => String(c).split(','))
        : [];
  const countries = resolveExplicitCountries(flat.map((c) => c.trim()).filter((c) => c.length > 0));
  return { heading, countries };
}
