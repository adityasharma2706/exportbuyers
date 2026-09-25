/**
 * M13 HS helper (API + UI) — public API. Other modules import ONLY from this file.
 * REQ-005 (suggest), REQ-006 (browse / direct entry / export policy), REQ-007 (save with
 * nomenclature version), REQ-004 (anonymous try within rate limits).
 *
 * IF-13a  POST /api/hs/suggest · GET /api/hs/browse · GET /api/hs/code/:code
 *         POST /api/workspaces/:id/hs (auth) · POST /api/anon/hs (anonymous)
 */
export { DEFAULT_HS_HELPER_CONFIG, hsHelperConfig, loadHsHelperConfig, setHsHelperConfig } from './config.js';
export type { HsHelperConfig } from './config.js';

export { HS_DISCLAIMER_KEY } from './types.js';
export type {
  HsBrowseDto,
  HsCandidateDto,
  HsCodeDetailDto,
  HsNodeDto,
  HsSavedSelectionDto,
  HsSuggestResponse,
} from './types.js';

export {
  EMBED_PURPOSE,
  RERANK_PURPOSE,
  RERANK_SCHEMA,
  applyRanking,
  buildRerankPrompt,
  normalizeQuery,
  queryEmbedding,
  retrieveCandidates,
  suggestHs,
  vectorFallback,
} from './suggest.js';

export {
  browseHs,
  codeDetail,
  defaultBrowseVersion,
  nodeDto,
  parseVersion,
  resolveSelection,
  saveAnonymousHs,
  saveWorkspaceHs,
} from './service.js';

export { registerHsHelperRoutes } from './routes.js';
export type { HsRouteApp, HsRouteReply, HsRouteRequest } from './routes.js';

export { HS_HELPER_MESSAGES_EN, HS_HELPER_NAMESPACE, fillLabel, resolveHsHelperLabels } from './labels.js';
export type { HsHelperLabelKey, HsHelperLabels } from './labels.js';

export { HsHelper, formatHsCode } from './components/HsHelper.js';
export type { HsHelperProps } from './components/HsHelper.js';
