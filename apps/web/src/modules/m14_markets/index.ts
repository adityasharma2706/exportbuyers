/**
 * M14 Market analytics — TS public API (read-only, IF-14a). Other modules import ONLY from this
 * file. Data for REQ-010, REQ-011 and REQ-013.
 *
 * marketRows(hs, {limit=30}) — ranked importing markets for an 8/6/4-digit code
 *
 * Ingestion (UN Comtrade), the FTA/CEPA table, the SCORE_V=1 batch ranking and the cached "why"
 * summaries live in the Python knowledge plane (py/kp/m14_markets).
 */
export {
  INDIA_SHARE_CAP,
  MIN_IMPORT_VALUE_USD,
  SCORE_V,
  SCORE_WEIGHTS,
  WHY_JOB_TYPE,
  WHY_RATE_CLASS,
  WHY_TEMPLATE_KEY,
  WHY_TOP_N,
} from './types.js';
export type {
  FtaInfo,
  MarketRepo,
  MarketRow,
  MarketRowLevel,
  MarketRowRecord,
  MarketRowsOptions,
  TopSupplier,
  WhyFallback,
  WhyJobRequest,
} from './types.js';
export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  marketRowKey,
  marketRows,
  parseSuppliers,
  setMarketRepoForTesting,
  toMarketRow,
  whyFallbackFor,
} from './markets.js';
export { pgMarketRepo, whyIdempotencyKey } from './repo.js';
