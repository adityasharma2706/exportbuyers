/**
 * M28 — price catalogue (IF-28c). Loaded once from `/config/prices.yaml` (LLD M28) and served
 * verbatim at `GET /api/prices`. `quote()` is the authoritative credit calculation; M04's
 * CostBadge (apps/web/src/modules/m04_ui/pricing/prices.ts) mirrors this formula for display only
 * — nothing there hard-codes a price.
 *
 * File discovery mirrors M10's pinned-file pattern (psl.ts): an env override, then a fixed
 * relative path from this file's own location (works for both `src/` and the mirrored `dist/`
 * layout, since both sit the same number of levels under apps/web), then a walk up from cwd.
 * Fails closed (INTERNAL) if the file cannot be found or is malformed, because this is money.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { AppError, type ActorContext } from '../m01_platform/index.js';
import type { Quote, QuoteOptions } from './types.js';

export const PRICES_RELATIVE_PATH = join('config', 'prices.yaml');

/** Credit-consuming actions (mirrors M04's PRICE_ACTIONS). */
export const PRICE_ACTIONS = ['reveal', 'reveal_bulk_each', 'check_buyer', 'export_row'] as const;
export type PriceAction = (typeof PRICE_ACTIONS)[number];

export function isPriceAction(v: unknown): v is PriceAction {
  return typeof v === 'string' && (PRICE_ACTIONS as readonly string[]).includes(v);
}

export interface PriceCatalogue {
  version: string;
  effectiveFrom: string | null;
  inrPerCredit: number | null;
  actions: Readonly<Record<string, number>>;
  countryMultipliers: Readonly<Record<string, number>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numberMap(raw: unknown, field: string, upperKeys: boolean): Record<string, number> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new AppError('INTERNAL', `prices.yaml: "${field}" must be a mapping`);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new AppError('INTERNAL', `prices.yaml: "${field}.${k}" must be a non-negative number`);
    }
    out[upperKeys ? k.toUpperCase() : k] = v;
  }
  return out;
}

/** Parses the already-YAML-decoded document (exported so tests do not need a file on disk). */
export function parseCatalogueDocument(raw: unknown): PriceCatalogue {
  if (!isRecord(raw)) throw new AppError('INTERNAL', 'prices.yaml: root must be a mapping');
  const version = raw.version;
  if ((typeof version !== 'string' || version.length === 0) && typeof version !== 'number') {
    throw new AppError('INTERNAL', 'prices.yaml: "version" is required');
  }
  const actions = numberMap(raw.actions, 'actions', false);
  if (Object.keys(actions).length === 0) throw new AppError('INTERNAL', 'prices.yaml: "actions" must not be empty');
  const countryMultipliers = numberMap(raw.country_multipliers ?? raw.countryMultipliers, 'country_multipliers', true);
  const effectiveFromRaw = raw.effective_from ?? raw.effectiveFrom;
  const effectiveFrom = typeof effectiveFromRaw === 'string' ? effectiveFromRaw : null;
  const inrRaw = raw.inr_per_credit ?? raw.inrPerCredit;
  const inrPerCredit = typeof inrRaw === 'number' && Number.isFinite(inrRaw) && inrRaw > 0 ? inrRaw : null;
  return { version: String(version), effectiveFrom, inrPerCredit, actions, countryMultipliers };
}

function candidatePaths(): string[] {
  const out: string[] = [];
  const env = process.env.M28_PRICES_FILE;
  if (env && env.trim()) out.push(resolve(env.trim()));
  try {
    // src/modules/m28_credits (and dist/modules/m28_credits) -> repository root is five levels up.
    const here = dirname(fileURLToPath(import.meta.url));
    out.push(resolve(here, '..', '..', '..', '..', '..', PRICES_RELATIVE_PATH));
  } catch {
    /* not a file URL (bundled); fall back to walking up from the cwd */
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    out.push(join(dir, PRICES_RELATIVE_PATH));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

let loaded: PriceCatalogue | undefined;

/** Loads (once) and returns the catalogue. Throws INTERNAL when the file is missing or malformed. */
export function getCatalogue(): PriceCatalogue {
  if (loaded) return loaded;
  for (const p of candidatePaths()) {
    if (existsSync(p)) {
      let parsed: unknown;
      try {
        parsed = loadYaml(readFileSync(p, 'utf8'));
      } catch (e) {
        throw new AppError('INTERNAL', `prices.yaml at ${p} is not valid YAML`, undefined, { cause: e });
      }
      loaded = parseCatalogueDocument(parsed);
      return loaded;
    }
  }
  throw new AppError('INTERNAL', `Price catalogue not found (${PRICES_RELATIVE_PATH}); set M28_PRICES_FILE`);
}

/** Test hook: installs a catalogue directly (undefined reloads from disk on next getCatalogue()). */
export function setCatalogueForTesting(c: PriceCatalogue | undefined): void {
  loaded = c;
}

/**
 * IF-28a. Pure: unit = ceil(base × countryMultiplier), total = unit × quantity. `ctx` is only
 * used to default the country to the actor's region when `opts.country` is omitted; pass `null`
 * for a country-less quote.
 */
export function quote(ctx: ActorContext | null, action: PriceAction, opts: QuoteOptions = {}): Quote {
  const catalogue = getCatalogue();
  const quantity = opts.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new AppError('VALIDATION', 'quantity must be a positive integer', { field: 'quantity' });
  }
  const base = catalogue.actions[action];
  if (base === undefined) throw new AppError('VALIDATION', `Action "${action}" is not priced`, { action });
  const countryRaw = opts.country ?? ctx?.region ?? null;
  const country = countryRaw ? countryRaw.trim().toUpperCase() : null;
  const multiplier = country ? (catalogue.countryMultipliers[country] ?? 1) : 1;
  // -1e-9 guards against float error nudging an exact integer product up by one credit.
  const unitCredits = Math.ceil(base * multiplier - 1e-9);
  return { credits: unitCredits * quantity, catalogueVersion: catalogue.version };
}

/** Serialisable DTO for GET /api/prices; matches what M04's parseCatalogue() expects. */
export function catalogueDto(c: PriceCatalogue = getCatalogue()): Record<string, unknown> {
  return {
    version: c.version,
    effectiveFrom: c.effectiveFrom,
    actions: { ...c.actions },
    countryMultipliers: { ...c.countryMultipliers },
    inrPerCredit: c.inrPerCredit,
  };
}
