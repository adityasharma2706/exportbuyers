/**
 * M15 IF-15a — coverage(country, hsHeading): the coverage label for one country × HS heading.
 *
 * Returns the heading row if it exists; otherwise the country-level fallback row (hs_heading '*')
 * with its explanation key suffixed `.country_level`; otherwise a synthetic `limited` cell. Until the
 * evidence store holds buyers for a country, that country is honestly Limited.
 */
import { AppError, log } from '../m01_platform/index.js';
import type { CoverageLabelValue } from '../m04_ui/index.js';
import { pgCoverageRepo } from './repo.js';
import type { CoverageCell, CoverageCellRecord, CoverageLevel, CoverageRepo } from './types.js';
import { COUNTRY_FALLBACK, COUNTRY_LEVEL_SUFFIX, COVERAGE_KEYS, RULE_V } from './types.js';

const COUNTRY_RE = /^[A-Z]{2}$/;
const CODE_RE = /^(?:[0-9]{4}|[0-9]{6}|[0-9]{8})$/;
const LABELS: readonly CoverageLabelValue[] = ['strong', 'partial', 'limited'];
const KEY_RE = /^coverage\.[a-z_.]+$/;

let repo: CoverageRepo = pgCoverageRepo;

export function setCoverageRepoForTesting(r: CoverageRepo | undefined): void {
  repo = r ?? pgCoverageRepo;
}

export function normalizeCountry(country: string): string {
  const c = typeof country === 'string' ? country.trim().toUpperCase() : '';
  if (!COUNTRY_RE.test(c)) {
    throw new AppError('VALIDATION', 'country must be an ISO 3166-1 alpha-2 code', { country });
  }
  return c;
}

/** '0901' → '0901'; '090111' / '09011190' / '0901.11' → '0901'. Chapters are refused. */
export function normalizeHeading(hs: string): string {
  const digits = typeof hs === 'string' ? hs.trim().replace(/[.\s-]/g, '') : '';
  if (!CODE_RE.test(digits)) {
    throw new AppError('VALIDATION', 'Coverage needs a 4, 6 or 8 digit HS code', { hs });
  }
  return digits.slice(0, 4);
}

function toInt(v: number | string | null | undefined): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function toIso(v: Date | string | null): string | undefined {
  if (v === null) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function parseParams(raw: unknown, fallbackCount: number): CoverageCell['params'] {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  }
  const src = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
  const count = typeof src.count === 'number' && Number.isFinite(src.count) ? src.count : fallbackCount;
  const sources = Array.isArray(src.sources) ? src.sources.filter((s): s is string => typeof s === 'string') : [];
  return { ...src, count, sources };
}

/** The synthetic cell used when neither a heading row nor a country row exists. */
export function syntheticLimited(country: string, hsHeading: string): CoverageCell {
  return {
    country,
    hsHeading,
    label: 'limited',
    level: 'none',
    explanationKey: COVERAGE_KEYS.limited,
    params: { count: 0, sources: [] },
    sourceTypes: [],
    companyCount: 0,
    freshCompanyCount: 0,
    ruleVersion: RULE_V,
  };
}

/**
 * Maps a stored row to the IF-15a result. A malformed row (unknown label or key) is logged and
 * degraded to the honest answer, limited, rather than shown with a label it may not deserve.
 */
export function toCoverageCell(rec: CoverageCellRecord, requestedHeading: string): CoverageCell {
  const level: CoverageLevel = rec.hs_heading === COUNTRY_FALLBACK ? 'country' : 'heading';
  const fresh = toInt(rec.fresh_company_count);
  const labelOk = (LABELS as readonly string[]).includes(rec.label);
  const keyOk = typeof rec.explanation_key === 'string' && KEY_RE.test(rec.explanation_key);
  let label: CoverageLabelValue = labelOk ? (rec.label as CoverageLabelValue) : 'limited';
  let key = keyOk ? rec.explanation_key : COVERAGE_KEYS.limited;
  if (!labelOk || !keyOk) {
    log.warn({ country: rec.country, hsHeading: rec.hs_heading, label: rec.label, key: rec.explanation_key },
      'm15: malformed coverage_cell row; serving limited');
    label = 'limited';
    key = COVERAGE_KEYS.limited;
  }
  if (level === 'country' && !key.endsWith(COUNTRY_LEVEL_SUFFIX)) key = `${key}${COUNTRY_LEVEL_SUFFIX}`;
  const cell: CoverageCell = {
    country: rec.country,
    hsHeading: requestedHeading,
    label,
    level,
    explanationKey: key,
    params: parseParams(rec.params, fresh),
    sourceTypes: Array.isArray(rec.source_types) ? rec.source_types.filter((s) => typeof s === 'string') : [],
    companyCount: toInt(rec.company_count),
    freshCompanyCount: fresh,
    ruleVersion: toInt(rec.rule_version) || RULE_V,
  };
  const at = toIso(rec.computed_at);
  if (at !== undefined) cell.computedAt = at;
  return cell;
}

/** Picks the heading row, else the fallback row, else a synthetic limited cell. */
export function selectCell(records: readonly CoverageCellRecord[], country: string, heading: string): CoverageCell {
  const exact = records.find((r) => r.country === country && r.hs_heading === heading);
  if (exact) return toCoverageCell(exact, heading);
  const fallback = records.find((r) => r.country === country && r.hs_heading === COUNTRY_FALLBACK);
  if (fallback) return toCoverageCell(fallback, heading);
  return syntheticLimited(country, heading);
}

/** IF-15a. `hsHeading` may be a 4, 6 or 8 digit code; it is reduced to its heading. */
export async function coverage(country: string, hsHeading: string): Promise<CoverageCell> {
  const c = normalizeCountry(country);
  const h = normalizeHeading(hsHeading);
  const records = await repo.cellsFor(c, h);
  return selectCell(records, c, h);
}
