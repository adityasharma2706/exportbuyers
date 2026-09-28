/**
 * M26 Buyer search (index, API + UI) — public API. Other modules import ONLY from this file.
 * REQ-015, REQ-016, REQ-018, REQ-019, REQ-020, REQ-012 (coverage label per row/country),
 * REQ-024 (lower-confidence label), REQ-004 (anonymous preview + signup gate),
 * REQ-051 (limited visible results, enforced by M10).
 *
 * IF-26a  POST /api/buyers/search · GET /api/buyers/discovery-status?heading&countries
 */
export {
  BUYER_SEARCH_DISCLAIMER_KEY,
  SIGNUP_GATE_REASON,
} from './types.js';
export type {
  BuyerSearchLimitDto,
  BuyerSearchResponseDto,
  DiscoveryState,
  DiscoveryStatusResponseDto,
  EvidenceSummaryItemDto,
  SearchRowDto,
} from './types.js';

export { buyerSearchConfig, isDiscoveryReleased, loadBuyerSearchConfig, setBuyerSearchConfig } from './config.js';
export type { BuyerSearchConfig } from './config.js';

export {
  buyerSearchInputSchema,
  parseBuyerSearchInput,
  parseDiscoveryStatusQuery,
  resolveDefaultCountries,
  resolveExplicitCountries,
  resolveExplicitHeadings,
  resolveKeyword,
  toHeading,
} from './validate.js';
export type { BuyerSearchInput } from './validate.js';

export { countriesNeedingDiscovery, discoveryStatusForCountries, triggerDiscoveryForCountries } from './discovery.js';

export { isLowConfidence, passesDiscoveryReleaseGate, strongestEvidenceConfidence, toSearchRowDto } from './rows.js';

export { discoveryStatus, resolveSearchQuery, searchBuyers } from './service.js';
export type { ResolvedSearch } from './service.js';

export { registerBuyerSearchRoutes } from './routes.js';
export type { BuyerSearchRouteApp, BuyerSearchRouteReply, BuyerSearchRouteRequest } from './routes.js';

export { BUYER_SEARCH_MESSAGES_EN, BUYER_SEARCH_NAMESPACE, fillLabel, resolveBuyerSearchLabels } from './labels.js';
export type { BuyerSearchLabelKey, BuyerSearchLabels } from './labels.js';

export { BuyerSearch } from './components/BuyerSearch.js';
export type { BuyerSearchProps } from './components/BuyerSearch.js';
