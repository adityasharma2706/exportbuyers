/**
 * M14 market analytics — TS types (read side of analytics.market_row / analytics.fta).
 */

/** Score formula version (LLD M14). Bumped whenever the weights or inputs change. */
export const SCORE_V = 1;
/** "Why" summaries are generated eagerly for the top N per code at build time. */
export const WHY_TOP_N = 15;
/** Countries importing less than this are excluded from the ranking [tunable]. */
export const MIN_IMPORT_VALUE_USD = 1_000_000;
/** India's share is capped at this value in the score (the leftover room is the signal). */
export const INDIA_SHARE_CAP = 0.5;
export const SCORE_WEIGHTS = { importValue: 0.45, cagr5y: 0.25, indiaRoom: 0.15, fta: 0.15 } as const;

/** Knowledge-plane job that writes one summary (py/kp/m14_markets). */
export const WHY_JOB_TYPE = 'm14.generate_why';
export const WHY_RATE_CLASS = 'm14.why';
/** i18n key of the template sentence shown when there is no generated summary. */
export const WHY_TEMPLATE_KEY = 'markets.why.template';

export type MarketRowLevel = 'hs6' | 'hs4';

export interface TopSupplier {
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** Share of the country's imports of the code, 0..1. */
  share: number;
}

export interface FtaInfo {
  partner: string;
  agreement: string;
  /** YYYY-MM-DD */
  inForceFrom: string;
  /** 'all' or a chapters list such as '01-24,28'. */
  hsScope: string;
  notes: string | null;
  sourceUrl: string | null;
}

export interface WhyFallback {
  key: typeof WHY_TEMPLATE_KEY;
  params: {
    country: string;
    code: string;
    dataYear: number;
    importValueUsdMillions: number;
    cagr5yPercent: number | null;
    indiaSharePercent: number | null;
  };
}

export interface MarketRow {
  /** Importing country, ISO 3166-1 alpha-2. */
  country: string;
  /** Row key: 6 digits, or '<4 digits>__' for an HS4 aggregate. */
  hs6: string;
  /** The code as the user sees it (6 or 4 digits). */
  code: string;
  level: MarketRowLevel;
  dataYear: number;
  importValueUsd: number;
  /** 5-year compound annual growth of imports (0.12 = 12 %/yr); null when unknown. */
  cagr5y: number | null;
  /** India's share of the country's imports, 0..1. */
  indiaShare: number | null;
  topSuppliers: TopSupplier[];
  ftaRef: string | null;
  fta: FtaInfo | null;
  score: number;
  scoreVersion: typeof SCORE_V;
  rank: number;
  /** Generated "why this market" summary, or null (use `whyFallback`). */
  why: string | null;
  whyFallback: WhyFallback;
  hsVersion: string;
  builtAt: string;
}

export interface MarketRowsOptions {
  /** 1..100, default 30. */
  limit?: number;
  /** Enqueue generation of missing summaries (lazy "why"). Default true. */
  ensureWhy?: boolean;
}

/** One analytics.market_row joined with its analytics.fta entry, as returned by the database. */
export interface MarketRowRecord {
  country: string;
  hs6: string;
  data_year: number;
  import_value_usd: string | number;
  cagr_5y: number | null;
  india_share: number | null;
  top_suppliers: unknown;
  fta_ref: string | null;
  score: number;
  rank: number;
  why_text: string | null;
  why_input_hash: string;
  hs_version: string;
  built_at: Date | string;
  fta_partner: string | null;
  fta_agreement: string | null;
  fta_in_force_from: string | null;
  fta_hs_scope: string | null;
  fta_notes: string | null;
  fta_source_url: string | null;
}

export interface WhyJobRequest {
  country: string;
  hs6: string;
  inputHash: string;
}

export interface MarketRepo {
  rowsForCode(code: string, limit: number): Promise<MarketRowRecord[]>;
  /** Idempotent per (country, code, hash). */
  enqueueWhy(req: WhyJobRequest): Promise<void>;
}
