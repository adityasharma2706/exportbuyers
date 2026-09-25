/**
 * M14 IF-14a — marketRows(hs, {limit}): the ranked importing markets for one code.
 *
 * Input: an 8-digit ITC-HS line (truncated to its HS6), an HS6 subheading, or a 4-digit heading
 * (served from the HS4 aggregate rows '<4 digits>__' computed at build time by summing values).
 * Rows are ordered by the SCORE_V=1 rank. A row without a summary gets one generated lazily: the
 * first request enqueues the knowledge-plane job (idempotent per the numbers' hash) and the UI shows
 * the template sentence (`whyFallback`) meanwhile, or permanently when the number check failed.
 */
import { AppError, log } from '../m01_platform/index.js';
import { normalizeCode } from '../m12_hs/index.js';
import { pgMarketRepo } from './repo.js';
import type {
  FtaInfo,
  MarketRepo,
  MarketRow,
  MarketRowLevel,
  MarketRowRecord,
  MarketRowsOptions,
  TopSupplier,
  WhyFallback,
} from './types.js';
import { SCORE_V, WHY_TEMPLATE_KEY } from './types.js';

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;
const AGG_SUFFIX = '__';
const COUNTRY_RE = /^[A-Z]{2}$/;

let repo: MarketRepo = pgMarketRepo;

export function setMarketRepoForTesting(r: MarketRepo | undefined): void {
  repo = r ?? pgMarketRepo;
}

/** '09011190' → '090111'; '090111' → '090111'; '0901' → '0901__'. Chapters are refused. */
export function marketRowKey(hs: string): { key: string; code: string; level: MarketRowLevel } {
  const c = normalizeCode(hs);
  switch (c.length) {
    case 8:
      return { key: c.slice(0, 6), code: c.slice(0, 6), level: 'hs6' };
    case 6:
      return { key: c, code: c, level: 'hs6' };
    case 4:
      return { key: `${c}${AGG_SUFFIX}`, code: c, level: 'hs4' };
    default:
      throw new AppError('VALIDATION', 'Market analytics need a 4, 6 or 8 digit HS code', { code: c });
  }
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AppError('VALIDATION', `limit must be an integer between 1 and ${MAX_LIMIT}`, { limit });
  }
  return limit;
}

function finiteOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function parseSuppliers(raw: unknown): TopSupplier[] {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: TopSupplier[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const { country, share } = item as { country?: unknown; share?: unknown };
    const s = finiteOrNull(share);
    if (typeof country === 'string' && COUNTRY_RE.test(country) && s !== null && s >= 0 && s <= 1) {
      out.push({ country, share: s });
    }
  }
  return out;
}

function ftaOf(r: MarketRowRecord): FtaInfo | null {
  if (!r.fta_agreement || !r.fta_partner || !r.fta_in_force_from || !r.fta_hs_scope) return null;
  return {
    partner: r.fta_partner,
    agreement: r.fta_agreement,
    inForceFrom: r.fta_in_force_from,
    hsScope: r.fta_hs_scope,
    notes: r.fta_notes,
    sourceUrl: r.fta_source_url,
  };
}

export function whyFallbackFor(row: {
  country: string;
  code: string;
  dataYear: number;
  importValueUsd: number;
  cagr5y: number | null;
  indiaShare: number | null;
}): WhyFallback {
  return {
    key: WHY_TEMPLATE_KEY,
    params: {
      country: row.country,
      code: row.code,
      dataYear: row.dataYear,
      importValueUsdMillions: round1(row.importValueUsd / 1_000_000),
      cagr5yPercent: row.cagr5y === null ? null : round1(row.cagr5y * 100),
      indiaSharePercent: row.indiaShare === null ? null : round1(row.indiaShare * 100),
    },
  };
}

export function toMarketRow(r: MarketRowRecord): MarketRow {
  const importValueUsd = finiteOrNull(r.import_value_usd) ?? 0;
  const aggregate = r.hs6.endsWith(AGG_SUFFIX);
  const code = aggregate ? r.hs6.slice(0, -AGG_SUFFIX.length) : r.hs6;
  const cagr5y = finiteOrNull(r.cagr_5y);
  const indiaShare = finiteOrNull(r.india_share);
  const dataYear = Number(r.data_year);
  const builtAt = r.built_at instanceof Date ? r.built_at.toISOString() : String(r.built_at);
  const why = typeof r.why_text === 'string' && r.why_text.trim().length > 0 ? r.why_text : null;
  return {
    country: r.country,
    hs6: r.hs6,
    code,
    level: aggregate ? 'hs4' : 'hs6',
    dataYear,
    importValueUsd,
    cagr5y,
    indiaShare,
    topSuppliers: parseSuppliers(r.top_suppliers),
    ftaRef: r.fta_ref,
    fta: ftaOf(r),
    score: finiteOrNull(r.score) ?? 0,
    scoreVersion: SCORE_V,
    rank: Number(r.rank),
    why,
    whyFallback: whyFallbackFor({ country: r.country, code, dataYear, importValueUsd, cagr5y, indiaShare }),
    hsVersion: r.hs_version,
    builtAt,
  };
}

/** IF-14a. */
export async function marketRows(hs: string, opts: MarketRowsOptions = {}): Promise<MarketRow[]> {
  const { key } = marketRowKey(hs);
  const limit = resolveLimit(opts.limit);
  const records = await repo.rowsForCode(key, limit);
  if (opts.ensureWhy !== false) {
    const missing = records.filter((r) => r.why_text === null && /^[0-9a-f]{64}$/.test(r.why_input_hash));
    for (const r of missing) {
      try {
        await repo.enqueueWhy({ country: r.country, hs6: r.hs6, inputHash: r.why_input_hash });
      } catch (err) {
        // A summary is an enhancement: the read never fails because the enqueue did.
        log.warn({ err, country: r.country, hs6: r.hs6 }, 'm14: could not enqueue lazy why summary');
      }
    }
  }
  return records.map(toMarketRow);
}
