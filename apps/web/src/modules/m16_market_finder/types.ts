/**
 * M16 Market Finder — wire DTOs (IF-16a). Type-only imports, so the client component can share them.
 *
 *   GET /api/markets?hs=<code>&version=   → MarketsResponse
 *   PUT /api/workspaces/:id/countries     → CountriesSavedDto
 *   PUT /api/anon/countries               → CountriesSavedDto
 */
import type { CoverageCellDto } from '../m04_ui/index.js';
import type { FtaInfo, TopSupplier, WhyFallback } from '../m14_markets/index.js';

/** Message key of the standard coverage disclaimer (M04 <Disclaimer kind="coverage" />). */
export const MARKETS_DISCLAIMER_KEY = 'disclaimer.coverage';

/** Guidance shown when the code has no market rows (LLD M16: "try the parent heading"). */
export const NO_ROWS_GUIDANCE_KEY = 'marketFinder.noRowsTryParent';
export const NO_ROWS_NO_PARENT_KEY = 'marketFinder.noRows';

export interface MarketRowDto {
  /** Importing country, ISO 3166-1 alpha-2. */
  country: string;
  rank: number;
  importValueUsd: number;
  /** 5-year compound annual growth (0.12 = 12 %/yr); null when unknown. */
  cagr5y: number | null;
  /** India's share of the country's imports of the code, 0..1; null when unknown. */
  indiaShare: number | null;
  /** Main competing supplier countries (India excluded; its share is `indiaShare`). */
  topSuppliers: TopSupplier[];
  /** India's trade agreement with the country, when it covers this product's chapter. */
  fta: FtaInfo | null;
  /** Generated "why this market" summary; null while it is being generated or unavailable. */
  why: string | null;
  /** Numbers for the template sentence shown when `why` is null. */
  whyFallback: WhyFallback;
  /** Buyer-data coverage label for (country, HS heading), with its explanation key and params. */
  coverage: CoverageCellDto;
}

export interface MarketsGuidanceDto {
  /** i18n key: NO_ROWS_GUIDANCE_KEY or NO_ROWS_NO_PARENT_KEY. */
  key: string;
  /** The parent heading to try, or null when the code is already a heading. */
  parentCode: string | null;
}

export interface MarketsResponse {
  /** The code the rows are for, as the user sees it (6 or 4 digits). */
  code: string;
  /** Nomenclature version echoed from the request (or the rows' version when not given). */
  version: string | null;
  rows: MarketRowDto[];
  /** Comtrade data year of the ranking; null when there are no rows. */
  dataYear: number | null;
  disclaimerKey: string;
  /** Present only when `rows` is empty. */
  guidance: MarketsGuidanceDto | null;
}

export interface CountriesSavedDto {
  countries: string[];
  /** Anonymous saves: false when the visitor has no persisted session, so nothing was stored. */
  persisted: boolean;
}
