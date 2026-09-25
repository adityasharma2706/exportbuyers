/**
 * M08 Source licence register — TS public API (read-only). Other modules import ONLY from this file.
 *
 * getSource(id)                   register entry (any status); NOT_FOUND when unregistered
 * findSource(id) / listSources()  lookups without throwing
 * sourceAllows(entry, use, region) display / export decision (REQ-048), region-aware
 * attributionsFor(ids)            attribution lines to show next to facts (REQ-033)
 * partitionExportable(ids)        which sources' facts may appear in an export (REQ-048)
 *
 * Connectors, raw landing and the lifecycle job live in the Python knowledge plane (kp.m08_sources).
 */
export { ALL_REGIONS, PERSONAL_DATA_CLASSES, SOURCE_STATUSES, SOURCE_TYPES } from './types.js';
export type { PersonalDataClass, SourceEntry, SourceStatus, SourceType, SourceUse } from './types.js';
export {
  CACHE_TTL_MS,
  attributionsFor,
  clearSourceCache,
  findSource,
  getSource,
  listSources,
  partitionExportable,
  regionAllowed,
  rowToEntry,
  setSourceLoaderForTesting,
  sourceAllows,
} from './register.js';
export type { SourceLoader, SourceRow } from './register.js';
