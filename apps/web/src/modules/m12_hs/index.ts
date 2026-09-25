/**
 * M12 HS nomenclature store — TS public API (read-only, IF-12a/b). Other modules import ONLY
 * from this file. Data for REQ-005, REQ-006, REQ-007 and REQ-009.
 *
 * browse / lookup / vectorSearch / currentVersion / correlate
 *
 * The loaders (WCO HS, DGFT ITC-HS, correlation tables, embeddings) live in the Python knowledge
 * plane (kp.m12_hs); they emit EV-12 `nomenclature.version_loaded {version}`.
 */
export {
  EV_NOMENCLATURE_VERSION_LOADED,
  EXPORT_POLICIES,
  HS_EMBEDDING_DIM,
  HS_FAMILIES,
  HS_LEVELS,
  HS_LEVEL_DIGITS,
  HS_RELATIONS,
  HS_SOURCE_IDS,
} from './types.js';
export type {
  CorrelationColumn,
  ExportPolicy,
  HsCodeRow,
  HsCorrelationResult,
  HsCorrelationRow,
  HsFamily,
  HsLevel,
  HsNode,
  HsRelation,
  HsRepo,
  NomenclatureVersionLoaded,
} from './types.js';
export {
  CODE_RE,
  CURRENT_VERSION_TTL_MS,
  DEFAULT_K,
  MAX_K,
  VERSION_RE,
  browse,
  clearHsCache,
  correlate,
  correspondingHsVersion,
  currentVersion,
  flipRelation,
  levelForCode,
  lookup,
  normalizeCode,
  relationFor,
  rowToNode,
  setHsRepoForTesting,
  vectorSearch,
  versionFamily,
} from './hs.js';
export { pgHsRepo, toVectorLiteral } from './repo.js';
