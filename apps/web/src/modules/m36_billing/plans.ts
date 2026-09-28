/**
 * M36 — plan catalogue (LLD M36 "Config"). Loaded once from `/config/plans.yaml`: Free, Starter,
 * Growth, each priced monthly and annually, with a monthly credit allowance and entitlements.
 *
 * File discovery mirrors M28's price-catalogue pattern (catalogue.ts): an env override, then a
 * fixed relative path from this file's own location (works for `src/` and the mirrored `dist/`
 * layout), then a walk up from cwd. Fails closed (INTERNAL) if the file cannot be found or is
 * malformed, since it drives both billing and Free-plan entitlements (REQ-051).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { AppError, type Entitlements } from '../m01_platform/index.js';
import { CYCLES, PLAN_KEYS, isCycle, isPlanKey, type Cycle, type PlanDefinition, type PlanEntitlements, type PlanKey, type PlansCatalogue } from './types.js';

export const PLANS_RELATIVE_PATH = join('config', 'plans.yaml');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonNegInt(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    throw new AppError('INTERNAL', `plans.yaml: "${field}" must be a non-negative integer`);
  }
  return raw;
}

function parseEntitlements(raw: unknown, planKey: string): PlanEntitlements {
  if (!isRecord(raw)) throw new AppError('INTERNAL', `plans.yaml: plans.${planKey}.entitlements must be a mapping`);
  return {
    searchResultCap: nonNegInt(raw.searchResultCap, `plans.${planKey}.entitlements.searchResultCap`),
    exportRowsPerMonth: nonNegInt(raw.exportRowsPerMonth, `plans.${planKey}.entitlements.exportRowsPerMonth`),
    bulkRevealMax: nonNegInt(raw.bulkRevealMax, `plans.${planKey}.entitlements.bulkRevealMax`),
    checksPerMonth: nonNegInt(raw.checksPerMonth, `plans.${planKey}.entitlements.checksPerMonth`),
    revealsIncludedPerMonth: nonNegInt(raw.revealsIncludedPerMonth, `plans.${planKey}.entitlements.revealsIncludedPerMonth`),
  };
}

function parseRazorpayPlanId(raw: unknown, planKey: PlanKey): PlanDefinition['razorpayPlanId'] {
  if (planKey === 'free') return null;
  if (!isRecord(raw)) throw new AppError('INTERNAL', `plans.yaml: plans.${planKey}.razorpayPlanId must be {monthly, annual}`);
  const monthly = raw.monthly;
  const annual = raw.annual;
  if (typeof monthly !== 'string' || monthly.length === 0 || typeof annual !== 'string' || annual.length === 0) {
    throw new AppError('INTERNAL', `plans.yaml: plans.${planKey}.razorpayPlanId.monthly/annual are required strings`);
  }
  return { monthly, annual };
}

function parsePlanDefinition(raw: unknown, planKey: PlanKey): PlanDefinition {
  if (!isRecord(raw)) throw new AppError('INTERNAL', `plans.yaml: plans.${planKey} must be a mapping`);
  const priceInrMonthly = nonNegInt(raw.priceInrMonthly, `plans.${planKey}.priceInrMonthly`);
  const priceInrAnnual = nonNegInt(raw.priceInrAnnual, `plans.${planKey}.priceInrAnnual`);
  const monthlyCredits = nonNegInt(raw.monthlyCredits, `plans.${planKey}.monthlyCredits`);
  return {
    key: planKey,
    priceInrMonthly,
    priceInrAnnual,
    razorpayPlanId: parseRazorpayPlanId(raw.razorpayPlanId, planKey),
    monthlyCredits,
    entitlements: parseEntitlements(raw.entitlements, planKey),
  };
}

/** Parses the already-YAML-decoded document (exported so tests do not need a file on disk). */
export function parsePlansDocument(raw: unknown): PlansCatalogue {
  if (!isRecord(raw)) throw new AppError('INTERNAL', 'plans.yaml: root must be a mapping');
  const version = raw.version;
  if ((typeof version !== 'string' || version.length === 0) && typeof version !== 'number') {
    throw new AppError('INTERNAL', 'plans.yaml: "version" is required');
  }
  const plansRaw = raw.plans;
  if (!isRecord(plansRaw)) throw new AppError('INTERNAL', 'plans.yaml: "plans" must be a mapping');
  const plans = {} as Record<PlanKey, PlanDefinition>;
  for (const key of PLAN_KEYS) {
    if (!(key in plansRaw)) throw new AppError('INTERNAL', `plans.yaml: plan "${key}" is missing`);
    plans[key] = parsePlanDefinition(plansRaw[key], key);
  }
  return { version: String(version), plans };
}

function candidatePaths(): string[] {
  const out: string[] = [];
  const env = process.env.M36_PLANS_FILE;
  if (env && env.trim()) out.push(resolve(env.trim()));
  try {
    // src/modules/m36_billing (and dist/modules/m36_billing) -> repository root is five levels up.
    const here = dirname(fileURLToPath(import.meta.url));
    out.push(resolve(here, '..', '..', '..', '..', '..', PLANS_RELATIVE_PATH));
  } catch {
    /* not a file URL (bundled); fall back to walking up from the cwd */
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    out.push(join(dir, PLANS_RELATIVE_PATH));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

let loaded: PlansCatalogue | undefined;

/** Loads (once) and returns the plan catalogue. Throws INTERNAL when the file is missing/malformed. */
export function getPlansCatalogue(): PlansCatalogue {
  if (loaded) return loaded;
  for (const p of candidatePaths()) {
    if (existsSync(p)) {
      let parsed: unknown;
      try {
        parsed = loadYaml(readFileSync(p, 'utf8'));
      } catch (e) {
        throw new AppError('INTERNAL', `plans.yaml at ${p} is not valid YAML`, undefined, { cause: e });
      }
      loaded = parsePlansDocument(parsed);
      return loaded;
    }
  }
  throw new AppError('INTERNAL', `Plan catalogue not found (${PLANS_RELATIVE_PATH}); set M36_PLANS_FILE`);
}

/** Test hook: installs a catalogue directly (undefined reloads from disk on next call). */
export function setPlansCatalogueForTesting(c: PlansCatalogue | undefined): void {
  loaded = c;
}

export function planDefinition(plan: PlanKey): PlanDefinition {
  const def = getPlansCatalogue().plans[plan];
  if (!def) throw new AppError('INTERNAL', `Plan "${plan}" is not in the catalogue`);
  return def;
}

/** Full Entitlements (plan + numeric caps) for a plan key — REQ-051/REQ-054. */
export function entitlementsForPlan(plan: PlanKey): Entitlements {
  return { plan, ...planDefinition(plan).entitlements };
}

export function freeEntitlements(): Entitlements {
  return entitlementsForPlan('free');
}

export function razorpayPlanId(plan: PlanKey, cycle: Cycle): string {
  const def = planDefinition(plan);
  if (!def.razorpayPlanId) throw new AppError('VALIDATION', `Plan "${plan}" has no Razorpay subscription (it is free)`, { plan });
  return def.razorpayPlanId[cycle];
}

export function monthlyCreditsFor(plan: PlanKey): number {
  return planDefinition(plan).monthlyCredits;
}

/** GET /api/plans DTO — camelCase, INR (REQ-054: plan allowances visible; the plan-comparison page). */
export function plansDto(catalogue: PlansCatalogue = getPlansCatalogue()): Record<string, unknown> {
  return {
    version: catalogue.version,
    plans: PLAN_KEYS.map((key) => {
      const p = catalogue.plans[key];
      return {
        plan: key,
        priceInrMonthly: p.priceInrMonthly,
        priceInrAnnual: p.priceInrAnnual,
        monthlyCredits: p.monthlyCredits,
        entitlements: { ...p.entitlements },
      };
    }),
  };
}

export { isCycle, isPlanKey, CYCLES, PLAN_KEYS };
