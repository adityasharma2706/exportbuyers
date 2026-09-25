/**
 * M08 — read-only access to the source licence register (knowledge.source) for the serving
 * plane. Used by M10 (what may be displayed, with which attribution — REQ-033) and M35 (what may
 * be exported — REQ-048). The register is written only by migrations seeded from
 * config/sources.yaml; nothing here writes.
 *
 * Lookups are cached in-process for CACHE_TTL_MS so a disabled or prohibited source takes
 * effect within a minute.
 */
import { AppError, log, systemDb } from '../m01_platform/index.js';
import {
  ALL_REGIONS,
  PERSONAL_DATA_CLASSES,
  SOURCE_STATUSES,
  SOURCE_TYPES,
  type PersonalDataClass,
  type SourceEntry,
  type SourceStatus,
  type SourceType,
  type SourceUse,
} from './types.js';

export const CACHE_TTL_MS = 60_000; // [tunable]
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
const REGION_RE = /^[A-Z]{2}$/;

/** Raw row shape as returned by pg for knowledge.source. */
export interface SourceRow {
  id: string;
  source_type: string;
  can_store: boolean;
  can_display: boolean;
  can_export: boolean;
  retention_days: number | null;
  attribution_text: string;
  personal_data_class: string;
  allowed_regions: string[] | null;
  status: string;
  notes: string | null;
  updated_at: Date | string | null;
}

export type SourceLoader = {
  one(id: string): Promise<SourceRow | undefined>;
  all(): Promise<SourceRow[]>;
};

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string, id: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new AppError('INTERNAL', `knowledge.source ${id}: invalid ${field}`, { sourceId: id, field });
}

/** Validates a database row. A malformed register row is an INTERNAL error, never silently allowed. */
export function rowToEntry(row: SourceRow): SourceEntry {
  const id = row.id;
  if (typeof id !== 'string' || !SOURCE_ID_RE.test(id)) {
    throw new AppError('INTERNAL', 'knowledge.source row has an invalid id');
  }
  const regions = (row.allowed_regions ?? []).map((r) => (r === ALL_REGIONS ? r : String(r).trim().toUpperCase()));
  for (const r of regions) {
    if (r !== ALL_REGIONS && !REGION_RE.test(r)) {
      throw new AppError('INTERNAL', `knowledge.source ${id}: invalid allowed region`, { sourceId: id, region: r });
    }
  }
  const retention = row.retention_days === null || row.retention_days === undefined ? null : Number(row.retention_days);
  if (retention !== null && (!Number.isInteger(retention) || retention < 1)) {
    throw new AppError('INTERNAL', `knowledge.source ${id}: invalid retention_days`, { sourceId: id });
  }
  const updatedAt = row.updated_at == null ? null : row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
  return {
    id,
    sourceType: oneOf<SourceType>(row.source_type, SOURCE_TYPES, 'source_type', id),
    canStore: row.can_store === true,
    canDisplay: row.can_display === true,
    canExport: row.can_export === true,
    retentionDays: retention,
    attributionText: String(row.attribution_text ?? ''),
    personalDataClass: oneOf<PersonalDataClass>(row.personal_data_class, PERSONAL_DATA_CLASSES, 'personal_data_class', id),
    allowedRegions: Object.freeze([...regions]),
    status: oneOf<SourceStatus>(row.status, SOURCE_STATUSES, 'status', id),
    notes: row.notes ?? null,
    updatedAt,
  };
}

const COLUMNS = [
  'id',
  'source_type',
  'can_store',
  'can_display',
  'can_export',
  'retention_days',
  'attribution_text',
  'personal_data_class',
  'allowed_regions',
  'status',
  'notes',
  'updated_at',
] as const;

const dbLoader: SourceLoader = {
  async one(id) {
    const row = await systemDb('m08 source licence register lookup')
      .selectFrom('knowledge.source')
      .select([...COLUMNS])
      .where('id', '=', id)
      .executeTakeFirst();
    return row as SourceRow | undefined;
  },
  async all() {
    const rows = await systemDb('m08 source licence register list')
      .selectFrom('knowledge.source')
      .select([...COLUMNS])
      .orderBy('id')
      .execute();
    return rows as SourceRow[];
  },
};

let loader: SourceLoader = dbLoader;
const cache = new Map<string, { at: number; entry: SourceEntry | null }>();
let allCache: { at: number; entries: SourceEntry[] } | undefined;

/** Test hook: replace the database loader (undefined restores it) and clear caches. */
export function setSourceLoaderForTesting(l: SourceLoader | undefined): void {
  loader = l ?? dbLoader;
  clearSourceCache();
}

export function clearSourceCache(): void {
  cache.clear();
  allCache = undefined;
}

/** The entry in any status, or null when the id is not registered. */
export async function findSource(id: string): Promise<SourceEntry | null> {
  if (typeof id !== 'string' || !SOURCE_ID_RE.test(id)) return null;
  const now = Date.now();
  const hit = cache.get(id);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.entry;
  const row = await loader.one(id);
  const entry = row ? rowToEntry(row) : null;
  cache.set(id, { at: now, entry });
  return entry;
}

/**
 * IF-08 (TS, read-only). Returns the register entry in any status so callers can decide how to
 * treat facts already collected; throws NOT_FOUND for an unregistered id.
 */
export async function getSource(id: string): Promise<SourceEntry> {
  const entry = await findSource(id);
  if (!entry) {
    log.warn({ sourceId: id }, 'source not in licence register');
    throw new AppError('NOT_FOUND', `Source "${id}" is not in the licence register`, { sourceId: id });
  }
  return entry;
}

export async function listSources(): Promise<SourceEntry[]> {
  const now = Date.now();
  if (allCache && now - allCache.at < CACHE_TTL_MS) return allCache.entries;
  const entries = (await loader.all()).map(rowToEntry);
  allCache = { at: now, entries };
  for (const e of entries) cache.set(e.id, { at: now, entry: e });
  return entries;
}

/** True when data about a subject in `region` (ISO alpha-2; null = unknown) may come from this source. */
export function regionAllowed(entry: SourceEntry, region: string | null | undefined): boolean {
  if (entry.allowedRegions.includes(ALL_REGIONS)) return true;
  if (!region) return false;
  return entry.allowedRegions.includes(region.trim().toUpperCase());
}

/**
 * Licence decision for one use of a fact from `entry`.
 *  - prohibited sources allow nothing;
 *  - disabled sources keep the rights their facts were collected under (no new collection);
 *  - export additionally requires display rights.
 */
export function sourceAllows(entry: SourceEntry, use: SourceUse, region?: string | null): boolean {
  if (entry.status === 'prohibited') return false;
  if (region !== undefined && !regionAllowed(entry, region)) return false;
  if (use === 'display') return entry.canDisplay;
  return entry.canExport && entry.canDisplay;
}

/** Distinct attribution lines for the given source ids, in first-seen order (REQ-033). */
export async function attributionsFor(sourceIds: Iterable<string>): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of new Set(sourceIds)) {
    const entry = await findSource(id);
    if (!entry || entry.status === 'prohibited') continue;
    const text = entry.attributionText.trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

/**
 * Splits source ids into those whose facts may be exported and those that may not (REQ-048).
 * Unregistered ids are never exportable.
 */
export async function partitionExportable(
  sourceIds: Iterable<string>,
): Promise<{ exportable: string[]; blocked: Array<{ sourceId: string; reason: 'not_registered' | 'prohibited' | 'no_export_right' }> }> {
  const exportable: string[] = [];
  const blocked: Array<{ sourceId: string; reason: 'not_registered' | 'prohibited' | 'no_export_right' }> = [];
  for (const id of new Set(sourceIds)) {
    const entry = await findSource(id);
    if (!entry) blocked.push({ sourceId: id, reason: 'not_registered' });
    else if (entry.status === 'prohibited') blocked.push({ sourceId: id, reason: 'prohibited' });
    else if (!sourceAllows(entry, 'export')) blocked.push({ sourceId: id, reason: 'no_export_right' });
    else exportable.push(id);
  }
  return { exportable, blocked };
}
