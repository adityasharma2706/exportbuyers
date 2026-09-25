/**
 * M16 Market Finder (API + UI) — public API. Other modules import ONLY from this file.
 * REQ-010 (ranked countries), REQ-011 (FTA advantage), REQ-012 (coverage label per country),
 * REQ-013 ("why this market"), REQ-014 (shortlist → buyer-search defaults), REQ-004 (anonymous try).
 *
 * IF-16a  GET /api/markets?hs=&version=
 *         PUT /api/workspaces/:id/countries (signed in) · PUT /api/anon/countries (anonymous)
 */
export {
  MARKETS_DISCLAIMER_KEY,
  NO_ROWS_GUIDANCE_KEY,
  NO_ROWS_NO_PARENT_KEY,
} from './types.js';
export type { CountriesSavedDto, MarketRowDto, MarketsGuidanceDto, MarketsResponse } from './types.js';

export {
  CACHE_TTL_EMPTY_SEC,
  CACHE_TTL_PENDING_WHY_SEC,
  CACHE_TTL_SEC,
  readCachedMarkets,
  setMarketCacheStoreForTesting,
  ttlFor,
  writeCachedMarkets,
} from './cache.js';
export type { CachedMarkets, MarketCacheStore } from './cache.js';

export {
  MAX_SUPPLIERS_SHOWN,
  competitorSuppliers,
  coverageDto,
  findMarkets,
  ftaCoversChapter,
  guidanceFor,
  parseMarketCode,
  saveAnonymousCountries,
  saveWorkspaceCountries,
  toRowDto,
} from './service.js';

export { registerMarketFinderRoutes } from './routes.js';
export type { MarketRouteApp, MarketRouteReply, MarketRouteRequest } from './routes.js';

export { MARKET_FINDER_MESSAGES_EN, MARKET_FINDER_NAMESPACE, resolveMarketFinderLabels } from './labels.js';
export type { MarketFinderLabelKey, MarketFinderLabels } from './labels.js';

export { MarketFinder, whyFromTemplate } from './components/MarketFinder.js';
export type { MarketFinderProps } from './components/MarketFinder.js';
