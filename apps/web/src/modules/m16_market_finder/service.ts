/**
 * M16 Market Finder — server side of IF-16a. REQ-010, REQ-011, REQ-012, REQ-013, REQ-014, REQ-004.
 *
 *   findMarkets(hs, version?)                  ranked countries (M14) + coverage per row (M15)
 *   saveWorkspaceCountries(ctx, id, body)      shortlist → workspace default countries (M07)
 *   saveAnonymousCountries(ctx, body)          shortlist → session.anon_state (carried over at sign-up)
 *
 * The anonymous rate-limit guard (guardAnonymous(ctx, 'market')) is applied by the route before
 * findMarkets runs, so cached answers are still rate-limited.
 */
import { AppError, isAppError, log, type ActorContext } from '../m01_platform/index.js';
import type { CoverageCellDto } from '../m04_ui/index.js';
import { requestMetaOf, requireMember } from '../m05_identity/index.js';
import { parseCountries, rememberAnonymousSelection, setCountries, tenancyConfig } from '../m07_tenancy/index.js';
import { parseVersion } from '../m13_hs_helper/index.js';
import { DEFAULT_LIMIT, marketRowKey, marketRows, type FtaInfo, type MarketRow, type TopSupplier } from '../m14_markets/index.js';
import { coverage, syntheticLimited, type CoverageCell } from '../m15_coverage/index.js';
import { readCachedMarkets, writeCachedMarkets, type CachedMarkets } from './cache.js';
import {
  MARKETS_DISCLAIMER_KEY,
  NO_ROWS_GUIDANCE_KEY,
  NO_ROWS_NO_PARENT_KEY,
  type CountriesSavedDto,
  type MarketRowDto,
  type MarketsGuidanceDto,
  type MarketsResponse,
} from './types.js';

const INDIA = 'IN';
/** Competing suppliers shown per country. [tunable] */
export const MAX_SUPPLIERS_SHOWN = 5;

// ---- input parsing --------------------------------------------------------------------------

/** Resolves the requested code to M14's row key; chapters and malformed codes are VALIDATION. */
export function parseMarketCode(raw: unknown): { key: string; code: string; level: 'hs6' | 'hs4' } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new AppError('VALIDATION', 'hs is required: a 4, 6 or 8 digit HS code', { field: 'hs' });
  }
  try {
    return marketRowKey(raw);
  } catch (e) {
    if (isAppError(e) && e.code === 'VALIDATION') {
      throw new AppError('VALIDATION', 'Market ranking needs a 4, 6 or 8 digit HS code', { field: 'hs' });
    }
    throw e;
  }
}

// ---- row shaping ----------------------------------------------------------------------------

/**
 * True when an FTA's HS scope covers the chapter. The scope is 'all' or a list such as '01-24,28'.
 * An unparseable scope is trusted (M14 already linked the agreement to this row).
 */
export function ftaCoversChapter(hsScope: string, code: string): boolean {
  const scope = hsScope.trim().toLowerCase();
  if (scope === 'all' || scope === '') return true;
  const chapter = Number.parseInt(code.slice(0, 2), 10);
  if (!Number.isInteger(chapter)) return true;
  let parsedAny = false;
  for (const part of scope.split(',')) {
    const m = /^\s*(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*$/.exec(part);
    if (!m) continue;
    parsedAny = true;
    const lo = Number.parseInt(m[1]!, 10);
    const hi = m[2] !== undefined ? Number.parseInt(m[2], 10) : lo;
    if (chapter >= Math.min(lo, hi) && chapter <= Math.max(lo, hi)) return true;
  }
  return !parsedAny;
}

/** Competing suppliers: India removed (its share is shown separately), largest first, capped. */
export function competitorSuppliers(suppliers: readonly TopSupplier[], importer: string): TopSupplier[] {
  return suppliers
    .filter((s) => s.country !== INDIA && s.country !== importer)
    .slice()
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_SUPPLIERS_SHOWN);
}

/** The M04 DTO part of an M15 cell (the counts behind it stay server-side). */
export function coverageDto(cell: CoverageCell): CoverageCellDto {
  const dto: CoverageCellDto = {
    country: cell.country,
    hsHeading: cell.hsHeading,
    label: cell.label,
    explanationKey: cell.explanationKey,
    params: cell.params,
    ruleVersion: cell.ruleVersion,
  };
  if (cell.computedAt !== undefined) dto.computedAt = cell.computedAt;
  return dto;
}

export function toRowDto(row: MarketRow, cell: CoverageCell): MarketRowDto {
  const fta: FtaInfo | null = row.fta && ftaCoversChapter(row.fta.hsScope, row.code) ? row.fta : null;
  return {
    country: row.country,
    rank: row.rank,
    importValueUsd: row.importValueUsd,
    cagr5y: row.cagr5y,
    indiaShare: row.indiaShare,
    topSuppliers: competitorSuppliers(row.topSuppliers, row.country),
    fta,
    why: row.why,
    whyFallback: row.whyFallback,
    coverage: coverageDto(cell),
  };
}

export function guidanceFor(code: string, level: 'hs6' | 'hs4'): MarketsGuidanceDto {
  return level === 'hs6'
    ? { key: NO_ROWS_GUIDANCE_KEY, parentCode: code.slice(0, 4) }
    : { key: NO_ROWS_NO_PARENT_KEY, parentCode: null };
}

/**
 * Coverage for every row (LLD: `coverage(country, hs.slice(0,4))`). A failed lookup degrades that
 * row to the honest answer, Limited, and marks the result as not cacheable.
 */
async function coverageForRows(rows: readonly MarketRow[], heading: string): Promise<{ cells: CoverageCell[]; degraded: boolean }> {
  let degraded = false;
  const byCountry = new Map<string, Promise<CoverageCell>>();
  for (const r of rows) {
    if (byCountry.has(r.country)) continue;
    byCountry.set(
      r.country,
      coverage(r.country, heading).catch((err: unknown) => {
        degraded = true;
        log.warn({ err, country: r.country, heading }, 'm16: coverage lookup failed; showing limited');
        return syntheticLimited(r.country, heading);
      }),
    );
  }
  const cells = await Promise.all(rows.map((r) => byCountry.get(r.country)!));
  return { cells, degraded };
}

async function computeMarkets(hs: string, code: string): Promise<{ value: CachedMarkets; cacheable: boolean }> {
  const rows = await marketRows(hs, { limit: DEFAULT_LIMIT });
  const ordered = rows.slice().sort((a, b) => a.rank - b.rank);
  const heading = code.slice(0, 4);
  const { cells, degraded } = await coverageForRows(ordered, heading);
  const dtos = ordered.map((r, i) => toRowDto(r, cells[i]!));
  const dataYear = ordered.length > 0 ? Math.max(...ordered.map((r) => r.dataYear)) : null;
  const rowsVersion = ordered[0]?.hsVersion ?? null;
  return { value: { code, rowsVersion, dataYear, rows: dtos }, cacheable: !degraded };
}

/** IF-16a GET /api/markets?hs=&version=. */
export async function findMarkets(rawHs: unknown, rawVersion?: unknown): Promise<MarketsResponse> {
  const { key, code, level } = parseMarketCode(rawHs);
  const version = parseVersion(rawVersion) ?? null;

  let value = await readCachedMarkets(key);
  if (!value) {
    const computed = await computeMarkets(rawHs as string, code);
    value = computed.value;
    if (computed.cacheable) await writeCachedMarkets(key, value);
  }

  return {
    code: value.code,
    version: version ?? value.rowsVersion,
    rows: value.rows,
    dataYear: value.dataYear,
    disclaimerKey: MARKETS_DISCLAIMER_KEY,
    guidance: value.rows.length === 0 ? guidanceFor(code, level) : null,
  };
}

// ---- shortlist (REQ-014) ----------------------------------------------------------------------

function countriesFromBody(body: unknown): string[] {
  const o = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!o || !('countries' in o)) {
    throw new AppError('VALIDATION', 'Body must be an object {countries: string[]}', { field: 'countries' });
  }
  if (!Array.isArray(o.countries)) {
    throw new AppError('VALIDATION', 'countries must be a list of country codes', { field: 'countries' });
  }
  return parseCountries(o.countries, 'countries', tenancyConfig().maxCountriesPerWorkspace);
}

/** PUT /api/workspaces/:id/countries — the shortlist becomes the workspace's default buyer-search countries. */
export async function saveWorkspaceCountries(ctx: ActorContext, workspaceId: string, body: unknown): Promise<CountriesSavedDto> {
  requireMember(ctx);
  const countries = countriesFromBody(body);
  await setCountries(ctx, workspaceId, countries);
  return { countries, persisted: true };
}

/** PUT /api/anon/countries — kept in the anonymous session and carried over at sign-up. */
export async function saveAnonymousCountries(ctx: ActorContext, body: unknown): Promise<CountriesSavedDto> {
  if (ctx.kind !== 'anonymous') {
    throw new AppError('VALIDATION', 'Signed-in users save countries to a workspace: PUT /api/workspaces/:id/countries', {
      subCode: 'USE_WORKSPACE',
    });
  }
  const countries = countriesFromBody(body);
  const meta = requestMetaOf(ctx);
  const persisted = Boolean(meta?.sessionId && meta.session?.anon);
  await rememberAnonymousSelection(ctx, { countries });
  return { countries, persisted };
}
