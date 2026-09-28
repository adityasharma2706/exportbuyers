/**
 * M26 — buyer search server side (IF-26a). REQ-015, REQ-016, REQ-018, REQ-019, REQ-020,
 * REQ-012, REQ-024, REQ-004, REQ-051.
 *
 *   searchBuyers(ctx, body)                 POST /api/buyers/search
 *   discoveryStatus(ctx, heading, countries) GET /api/buyers/discovery-status
 *
 * Every result passes through M10 (IF-10a `search`), which already applies suppression,
 * sanctions, licence, region, logistics, per-user hides and the plan/anonymous cap (REQ-051).
 * This module adds: defaulting countries/HS code from the workspace or the anonymous session,
 * the coverage label and "finding more buyers…" state per country (M15 + IF-20a), the
 * lower-confidence label (REQ-024) and the discovery precision-bar release gate (HLD OQ9).
 */
import { AppError, log, type ActorContext } from '../m01_platform/index.js';
import { requestMetaOf } from '../m05_identity/index.js';
import { getWorkspace } from '../m07_tenancy/index.js';
import { search as m10Search, type SearchQuery } from '../m10_policy/index.js';
import type { CoverageCellDto } from '../m04_ui/index.js';
import { coverageDto } from '../m16_market_finder/index.js';
import { coverage, syntheticLimited, type CoverageCell } from '../m15_coverage/index.js';
import { buyerSearchConfig } from './config.js';
import { countriesNeedingDiscovery, discoveryStatusForCountries, triggerDiscoveryForCountries } from './discovery.js';
import { passesDiscoveryReleaseGate, toSearchRowDto } from './rows.js';
import {
  parseBuyerSearchInput,
  resolveDefaultCountries,
  resolveExplicitCountries,
  resolveExplicitHeadings,
  resolveKeyword,
  toHeading,
  type BuyerSearchInput,
} from './validate.js';
import type { BuyerSearchResponseDto, DiscoveryState } from './types.js';

// ---- defaulting -------------------------------------------------------------------------------

interface Defaults {
  countries: string[];
  hsCode: string | null;
}

/** `session.anon_state` shape written by M07's `rememberAnonymousSelection` / M13's `saveAnonymousHs`. */
function anonymousDefaults(ctx: ActorContext): Defaults {
  const state = requestMetaOf(ctx)?.session?.anon_state as Record<string, unknown> | undefined;
  const countries = Array.isArray(state?.countries)
    ? (state.countries as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  const hsCode = typeof state?.hsCode === 'string' ? state.hsCode : null;
  return { countries, hsCode };
}

async function workspaceDefaults(ctx: ActorContext, workspaceId: string): Promise<Defaults> {
  const ws = await getWorkspace(ctx, workspaceId);
  return { countries: ws.countries, hsCode: ws.hs?.code ?? null };
}

async function loadDefaults(ctx: ActorContext, workspaceId: string | undefined): Promise<Defaults> {
  if (workspaceId && (ctx.kind === 'user' || ctx.kind === 'admin')) return workspaceDefaults(ctx, workspaceId);
  if (ctx.kind === 'anonymous') return anonymousDefaults(ctx);
  return { countries: [], hsCode: null };
}

export interface ResolvedSearch {
  query: SearchQuery;
  /** The primary heading, used for the (single) coverage cell and discovery decision per country. */
  heading: string;
}

/**
 * Builds the M10 SearchQuery from the request body, defaulting `countries` from the workspace
 * (or the anonymous session) and `hsHeadings` from the workspace's HS code truncated to its
 * 4-digit heading (LLD M26 API: "countries default = workspace.countries; hsHeadings default =
 * workspace.hs_code[0..4]").
 */
export async function resolveSearchQuery(ctx: ActorContext, rawBody: unknown): Promise<ResolvedSearch> {
  const input: BuyerSearchInput = parseBuyerSearchInput(rawBody);
  const defaults = await loadDefaults(ctx, input.workspaceId);

  const countries =
    input.countries && input.countries.length > 0
      ? resolveExplicitCountries(input.countries)
      : (() => {
          const d = resolveDefaultCountries(defaults.countries);
          if (d.length === 0) throw new AppError('VALIDATION', 'Choose at least one country', { field: 'countries' });
          return d;
        })();

  let headings: string[];
  if (input.hsHeadings && input.hsHeadings.length > 0) {
    headings = resolveExplicitHeadings(input.hsHeadings);
  } else {
    if (!defaults.hsCode) {
      throw new AppError('VALIDATION', 'Choose your product HS code first', { field: 'hsHeadings', subCode: 'NO_HS_CODE' });
    }
    headings = [toHeading(defaults.hsCode)];
  }

  const keyword = resolveKeyword(input.keyword);

  const query: SearchQuery = {
    hsHeadings: headings,
    countries,
    sort: input.sort ?? 'relevance',
    page: input.page ?? 1,
    pageSize: input.pageSize ?? 20,
  };
  if (keyword !== undefined) query.keyword = keyword;
  if (input.buyerTypes) query.buyerTypes = input.buyerTypes;
  if (input.activeWithinMonths !== undefined) query.activeWithinMonths = input.activeWithinMonths;
  if (input.minShipments12m !== undefined) query.minShipments12m = input.minShipments12m;
  if (input.trustLevels) query.trustLevels = input.trustLevels;
  if (input.contactTypes) query.contactTypes = input.contactTypes;
  if (input.originIndia !== undefined) query.originIndia = input.originIndia;
  if (input.originCompetitor !== undefined) query.originCompetitor = input.originCompetitor;
  if (input.includeLogistics !== undefined) query.includeLogistics = input.includeLogistics;

  return { query, heading: headings[0]! };
}

// ---- coverage -----------------------------------------------------------------------------

async function coverageForCountries(countries: readonly string[], heading: string): Promise<Map<string, CoverageCell>> {
  const out = new Map<string, CoverageCell>();
  await Promise.all(
    countries.map(async (country) => {
      try {
        out.set(country, await coverage(country, heading));
      } catch (err) {
        log.warn({ err, country, heading }, 'm26: coverage lookup failed; showing limited');
        out.set(country, syntheticLimited(country, heading));
      }
    }),
  );
  return out;
}

// ---- search ---------------------------------------------------------------------------------

/** POST /api/buyers/search (IF-26a). Anonymous rate limiting (`guardAnonymous`) is the route's job. */
export async function searchBuyers(ctx: ActorContext, rawBody: unknown): Promise<BuyerSearchResponseDto> {
  const { query, heading } = await resolveSearchQuery(ctx, rawBody);
  const result = await m10Search(ctx, 'search', query);

  const cells = await coverageForCountries(query.countries, heading);
  const cfg = buyerSearchConfig();
  const needing = countriesNeedingDiscovery(cells, cfg.discoveryMinCompanies);
  const requestedBy = ctx.kind === 'user' || ctx.kind === 'admin' ? ctx.accountId ?? null : null;
  if (needing.length > 0) await triggerDiscoveryForCountries(heading, needing, requestedBy);

  // Reflects the actual platform.job state per country: 'idle' when no on-demand job has ever
  // been requested for today's key (a well-covered country never needs one), 'running' while
  // IF-20a's job is in flight, 'done' once it (or an earlier request today) has completed.
  const discovery: Record<string, DiscoveryState> = await discoveryStatusForCountries(heading, query.countries);

  const rows = result.rows.filter((r) => r.preview !== undefined || passesDiscoveryReleaseGate(r.doc)).map(toSearchRowDto);

  const coverageOut: Record<string, CoverageCellDto> = {};
  for (const country of query.countries) {
    const cell = cells.get(country) ?? syntheticLimited(country, heading);
    coverageOut[country] = coverageDto(cell);
  }

  const out: BuyerSearchResponseDto = {
    rows,
    total: result.total,
    shown: result.shown,
    coverage: coverageOut,
    discovery,
    previewMode: ctx.kind === 'anonymous',
  };
  if (result.limit) out.limit = result.limit;
  return out;
}

// ---- discovery status polling ----------------------------------------------------------------

/** GET /api/buyers/discovery-status?heading&countries (IF-26a): polled every 5 s for up to 3 min. */
export async function discoveryStatus(heading: string, countries: readonly string[]): Promise<Record<string, DiscoveryState>> {
  return discoveryStatusForCountries(heading, countries);
}
