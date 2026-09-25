/**
 * M12 — IF-12a/b read API over the HS nomenclature store.
 *
 *   browse(version, parentCode|null)            children of a node; null = the chapters
 *   lookup(version, code)                       one node or null
 *   vectorSearch(version, queryEmbedding, k=30) nearest descriptions by cosine similarity
 *   currentVersion(level)                       current HS version, or current ITC-HS for 'national8'
 *   correlate(fromVersion, code, toVersion)     codes the given code maps to in another version
 *
 * ITC-HS versions hold only national 8-digit lines; browsing or looking up a 2/4/6-digit code in
 * an ITC-HS version reads the corresponding HS version (same year), so the ITC-HS tree can be
 * walked from the chapters down to the 8-digit lines.
 */
import { AppError } from '../m01_platform/index.js';
import { pgHsRepo } from './repo.js';
import {
  EXPORT_POLICIES,
  HS_EMBEDDING_DIM,
  HS_LEVELS,
  HS_RELATIONS,
  type CorrelationColumn,
  type ExportPolicy,
  type HsCodeRow,
  type HsCorrelationResult,
  type HsCorrelationRow,
  type HsFamily,
  type HsLevel,
  type HsNode,
  type HsRelation,
  type HsRepo,
} from './types.js';

export const VERSION_RE = /^(HS|ITCHS)([0-9]{4})$/;
export const CODE_RE = /^([0-9]{2}|[0-9]{4}|[0-9]{6}|[0-9]{8})$/;
export const DEFAULT_K = 30;
export const MAX_K = 200;
export const CURRENT_VERSION_TTL_MS = 60_000; // [tunable]

let repo: HsRepo = pgHsRepo;
const currentCache = new Map<HsFamily, { at: number; version: string }>();

/** Test hook: replace the database access (undefined restores Postgres) and clear caches. */
export function setHsRepoForTesting(r: HsRepo | undefined): void {
  repo = r ?? pgHsRepo;
  clearHsCache();
}

/** Clears the current-version cache (EV-12 handlers in the serving plane call this). */
export function clearHsCache(): void {
  currentCache.clear();
}

// ---- helpers -------------------------------------------------------------------------------

export function versionFamily(version: string): HsFamily {
  const m = VERSION_RE.exec(version);
  if (!m) throw new AppError('VALIDATION', `Invalid HS nomenclature version "${version}"`, { version });
  return m[1] as HsFamily;
}

/** 'ITCHS2022' → 'HS2022'; HS versions map to themselves. */
export function correspondingHsVersion(version: string): string {
  const m = VERSION_RE.exec(version);
  if (!m) throw new AppError('VALIDATION', `Invalid HS nomenclature version "${version}"`, { version });
  return `HS${m[2]}`;
}

export function levelForCode(code: string): HsLevel {
  switch (code.length) {
    case 2:
      return 'chapter';
    case 4:
      return 'heading';
    case 6:
      return 'subheading';
    case 8:
      return 'national8';
    default:
      throw new AppError('VALIDATION', 'An HS code has 2, 4, 6 or 8 digits', { code });
  }
}

/** Accepts '0101.21', '0101 21', '010121'; returns digits only. Throws VALIDATION on anything else. */
export function normalizeCode(code: string): string {
  if (typeof code !== 'string') throw new AppError('VALIDATION', 'HS code must be a string');
  const digits = code.trim().replace(/[.\s-]/g, '');
  if (!CODE_RE.test(digits)) throw new AppError('VALIDATION', 'An HS code has 2, 4, 6 or 8 digits', { code });
  return digits;
}

function assertVersion(version: string): HsFamily {
  if (typeof version !== 'string') throw new AppError('VALIDATION', 'HS version must be a string');
  return versionFamily(version);
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], field: string, code: string): T {
  if (value !== null && (allowed as readonly string[]).includes(value)) return value as T;
  throw new AppError('INTERNAL', `knowledge.hs_code ${code}: invalid ${field}`, { code, field });
}

/** Validates a database row. A malformed row is an INTERNAL error. */
export function rowToNode(row: HsCodeRow): HsNode {
  const level = oneOf<HsLevel>(row.level, HS_LEVELS, 'level', row.code);
  const node: HsNode = {
    version: row.version,
    code: row.code,
    level,
    parentCode: row.parent_code ?? null,
    description: row.description,
    descriptionEnSimple: row.description_en_simple ?? null,
    exportPolicy:
      row.export_policy == null ? null : oneOf<ExportPolicy>(row.export_policy, EXPORT_POLICIES, 'export_policy', row.code),
    policyConditions: row.policy_conditions ?? null,
    policySourceUrl: row.policy_source_url ?? null,
  };
  if (row.similarity !== undefined && row.similarity !== null) {
    const s = Number(row.similarity);
    if (Number.isFinite(s)) node.similarity = s;
  }
  return node;
}

/** Relation for a pair given how many source codes feed the target and how many targets the source has. */
export function relationFor(sourcesOfTarget: number, targetsOfSource: number): HsRelation {
  return `${sourcesOfTarget > 1 ? 'n' : '1'}:${targetsOfSource > 1 ? 'n' : '1'}` as HsRelation;
}

/** Reading a table backwards swaps the sides of the relation. */
export function flipRelation(r: HsRelation): HsRelation {
  if (r === '1:n') return 'n:1';
  if (r === 'n:1') return '1:n';
  return r;
}

function asRelation(value: string): HsRelation {
  if ((HS_RELATIONS as readonly string[]).includes(value)) return value as HsRelation;
  throw new AppError('INTERNAL', `knowledge.hs_correlation: invalid relation "${value}"`);
}

// ---- IF-12a --------------------------------------------------------------------------------

export async function browse(version: string, parentCode: string | null): Promise<HsNode[]> {
  const family = assertVersion(version);
  const parent = parentCode == null ? null : normalizeCode(parentCode);
  if (parent !== null && parent.length === 8) return []; // national lines are leaves
  if (family === 'ITCHS') {
    // Above the 6-digit level the ITC-HS tree is the HS tree of the same year.
    if (parent === null || parent.length < 6) return (await repo.children(correspondingHsVersion(version), parent)).map(rowToNode);
    return (await repo.children(version, parent)).map(rowToNode);
  }
  return (await repo.children(version, parent)).map(rowToNode);
}

export async function lookup(version: string, code: string): Promise<HsNode | null> {
  const family = assertVersion(version);
  const c = normalizeCode(code);
  if (family === 'HS' && c.length === 8) return null; // HS versions have no national lines
  const readVersion = family === 'ITCHS' && c.length < 8 ? correspondingHsVersion(version) : version;
  const row = await repo.one(readVersion, c);
  return row ? rowToNode(row) : null;
}

/**
 * Nearest codes by cosine similarity of their description embeddings. `opts.levels` narrows
 * the search (e.g. M13 searches HS 'subheading' only).
 */
export async function vectorSearch(
  version: string,
  queryEmbedding: number[],
  k: number = DEFAULT_K,
  opts: { levels?: readonly HsLevel[] } = {},
): Promise<HsNode[]> {
  assertVersion(version);
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length !== HS_EMBEDDING_DIM) {
    throw new AppError('VALIDATION', `queryEmbedding must have ${HS_EMBEDDING_DIM} dimensions`, {
      got: Array.isArray(queryEmbedding) ? queryEmbedding.length : null,
    });
  }
  if (!queryEmbedding.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new AppError('VALIDATION', 'queryEmbedding must contain finite numbers only');
  }
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
    throw new AppError('VALIDATION', `k must be an integer between 1 and ${MAX_K}`, { k });
  }
  const levels = opts.levels ?? null;
  if (levels) {
    for (const l of levels) {
      if (!(HS_LEVELS as readonly string[]).includes(l)) throw new AppError('VALIDATION', `Invalid HS level "${l}"`);
    }
  }
  return (await repo.nearest(version, queryEmbedding, k, levels)).map(rowToNode);
}

// ---- IF-12b --------------------------------------------------------------------------------

/** The current version for a level: ITC-HS for 'national8', WCO HS otherwise. NOT_FOUND when none is loaded. */
export async function currentVersion(level: HsLevel): Promise<string> {
  if (!(HS_LEVELS as readonly string[]).includes(level)) {
    throw new AppError('VALIDATION', `Invalid HS level "${String(level)}"`);
  }
  const family: HsFamily = level === 'national8' ? 'ITCHS' : 'HS';
  const now = Date.now();
  const hit = currentCache.get(family);
  if (hit && now - hit.at < CURRENT_VERSION_TTL_MS) return hit.version;
  const v = await repo.currentVersion(family);
  if (!v) throw new AppError('NOT_FOUND', `No current ${family} nomenclature version is loaded`, { family });
  currentCache.set(family, { at: now, version: v });
  return v;
}

interface Pair {
  src: string;
  dst: string;
  relation: HsRelation;
}

/**
 * Codes that `code` (in fromVersion) corresponds to in toVersion.
 *
 * - The (fromVersion → toVersion) table is used; if only the reverse table is loaded it is read
 *   backwards with 1:n and n:1 swapped.
 * - Codes present in the table return the table's rows as loaded.
 * - Coarser codes (e.g. a 4-digit heading against a 6-digit table) are aggregated: the targets
 *   are the distinct prefixes (same length) of the mapped codes, and the relation is derived
 *   from how many source prefixes feed each target prefix.
 * - Returns [] when the code has no correlation rows. NOT_FOUND when no table links the versions.
 */
export async function correlate(fromVersion: string, code: string, toVersion: string): Promise<HsCorrelationResult[]> {
  assertVersion(fromVersion);
  assertVersion(toVersion);
  const c = normalizeCode(code);
  if (fromVersion === toVersion) {
    return (await lookup(fromVersion, c)) ? [{ code: c, relation: '1:1' }] : [];
  }

  let tableFrom = fromVersion;
  let tableTo = toVersion;
  let reversed = false;
  if (!(await repo.hasCorrelationTable(fromVersion, toVersion))) {
    if (!(await repo.hasCorrelationTable(toVersion, fromVersion))) {
      throw new AppError('NOT_FOUND', `No correlation table between ${fromVersion} and ${toVersion} is loaded`, {
        fromVersion,
        toVersion,
      });
    }
    tableFrom = toVersion;
    tableTo = fromVersion;
    reversed = true;
  }
  const srcCol: CorrelationColumn = reversed ? 'to_code' : 'from_code';
  const dstCol: CorrelationColumn = reversed ? 'from_code' : 'to_code';
  const norm = (r: HsCorrelationRow): Pair => {
    const rel = asRelation(r.relation);
    return reversed
      ? { src: r.to_code, dst: r.from_code, relation: flipRelation(rel) }
      : { src: r.from_code, dst: r.to_code, relation: rel };
  };

  const direct = (await repo.correlationRows(tableFrom, tableTo, srcCol, c, true)).map(norm);
  if (direct.length > 0) return dedupe(direct.map((p) => ({ code: p.dst, relation: p.relation })));

  // Aggregate finer rows under a coarser code.
  const finer = (await repo.correlationRows(tableFrom, tableTo, srcCol, c, false))
    .map(norm)
    .filter((p) => p.src.length > c.length && p.dst.length >= c.length);
  if (finer.length === 0) return [];
  const len = c.length;
  const targets = [...new Set(finer.map((p) => p.dst.slice(0, len)))].sort();
  const out: HsCorrelationResult[] = [];
  for (const t of targets) {
    const feeding = (await repo.correlationRows(tableFrom, tableTo, dstCol, t, false))
      .map(norm)
      .filter((p) => p.src.length >= len)
      .map((p) => p.src.slice(0, len));
    const sources = new Set(feeding);
    sources.add(c);
    out.push({ code: t, relation: relationFor(sources.size, targets.length) });
  }
  return out;
}

function dedupe(rows: HsCorrelationResult[]): HsCorrelationResult[] {
  const seen = new Set<string>();
  const out: HsCorrelationResult[] = [];
  for (const r of rows) {
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    out.push(r);
  }
  return out;
}
