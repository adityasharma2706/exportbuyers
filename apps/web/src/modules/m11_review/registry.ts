/**
 * M11 — item-type registry (IF-11b), SLA configuration and RBAC per type.
 */
import { AppError } from '../m01_platform/index.js';
import type { AdminRole } from '../m05_identity/index.js';
import type { ReviewTypeDef } from './types.js';

export const TYPE_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
const OUTCOME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_SLA_HOURS = 24 * 90;

export const ADMIN_ROLE_RANK: Readonly<Record<AdminRole, number>> = { admin_support: 1, admin_ops: 2, admin_super: 3 };
export const ADMIN_ROLES: readonly AdminRole[] = ['admin_support', 'admin_ops', 'admin_super'];

/**
 * LLD M11 SLA values [tunable]: removal 72 h, sanctions possible-match 24 h, reports 5 d,
 * money-back 7 d. Owning modules pass these (or their own) as `slaHours`; these constants let
 * them share the tuned numbers.
 */
export const DEFAULT_SLA_HOURS = Object.freeze({
  removal: 72,
  sanctionsPossibleMatch: 24,
  report: 5 * 24,
  moneyBack: 7 * 24,
  deadLetter: 24,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyReviewTypeDef = ReviewTypeDef<any, any>;

const types = new Map<string, AnyReviewTypeDef>();
const slaOverrides = new Map<string, number>();

function assertSlaHours(type: string, h: number): void {
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || h > MAX_SLA_HOURS) {
    throw new AppError('VALIDATION', `Review type ${type}: slaHours must be a number in (0, ${MAX_SLA_HOURS}]`);
  }
}

export function validateTypeDef(def: AnyReviewTypeDef): void {
  if (!def || typeof def !== 'object') throw new AppError('VALIDATION', 'registerType(): definition is required');
  if (typeof def.type !== 'string' || !TYPE_NAME_RE.test(def.type)) {
    throw new AppError('VALIDATION', `registerType(): invalid type name "${String(def.type)}"`);
  }
  const t = def.type;
  if (!def.payloadSchema || typeof def.payloadSchema.safeParse !== 'function') {
    throw new AppError('VALIDATION', `registerType(${t}): payloadSchema must be a zod schema`);
  }
  if (!def.outcomeSchema || typeof def.outcomeSchema.safeParse !== 'function') {
    throw new AppError('VALIDATION', `registerType(${t}): outcomeSchema must be a zod schema`);
  }
  if (!Array.isArray(def.outcomes) || def.outcomes.length === 0) {
    throw new AppError('VALIDATION', `registerType(${t}): at least one outcome is required`);
  }
  const seen = new Set<string>();
  for (const o of def.outcomes) {
    if (typeof o !== 'string' || !OUTCOME_RE.test(o)) throw new AppError('VALIDATION', `registerType(${t}): invalid outcome "${String(o)}"`);
    if (seen.has(o)) throw new AppError('VALIDATION', `registerType(${t}): duplicate outcome "${o}"`);
    seen.add(o);
  }
  for (const o of def.rejectingOutcomes ?? []) {
    if (!seen.has(o)) throw new AppError('VALIDATION', `registerType(${t}): rejecting outcome "${o}" is not in outcomes`);
  }
  assertSlaHours(t, def.slaHours);
  if (!def.view || typeof def.view.titleKey !== 'string' || !Array.isArray(def.view.fields)) {
    throw new AppError('VALIDATION', `registerType(${t}): view must have titleKey and fields`);
  }
  if (typeof def.onOutcome !== 'function') throw new AppError('VALIDATION', `registerType(${t}): onOutcome must be a function`);
  if (def.requiredRole !== undefined && !ADMIN_ROLES.includes(def.requiredRole)) {
    throw new AppError('VALIDATION', `registerType(${t}): invalid requiredRole "${String(def.requiredRole)}"`);
  }
}

/** Adds the definition to the in-process registry. Wiring (event subscription) is done by the caller. */
export function addType(def: AnyReviewTypeDef): void {
  validateTypeDef(def);
  if (types.has(def.type)) throw new AppError('CONFLICT', `Review type "${def.type}" is already registered`);
  types.set(def.type, def);
}

export function getType(type: string): AnyReviewTypeDef | undefined {
  return types.get(type);
}

export function requireType(type: string): AnyReviewTypeDef {
  const def = types.get(type);
  if (!def) throw new AppError('VALIDATION', `Unknown review item type "${type}"`, { type });
  return def;
}

export function registeredTypes(): AnyReviewTypeDef[] {
  return [...types.values()];
}

export function requiredRoleOf(def: AnyReviewTypeDef): AdminRole {
  return def.requiredRole ?? 'admin_super';
}

export function roleMayHandle(role: AdminRole, def: AnyReviewTypeDef): boolean {
  return ADMIN_ROLE_RANK[role] >= ADMIN_ROLE_RANK[requiredRoleOf(def)];
}

/** The types an admin with `role` may see, claim and resolve. */
export function typesVisibleTo(role: AdminRole): string[] {
  return registeredTypes()
    .filter((d) => roleMayHandle(role, d))
    .map((d) => d.type);
}

/** Tunes SLA hours per type (e.g. from ops config). Pass `null` to clear an override. */
export function configureReviewSla(overrides: Readonly<Record<string, number | null>>): void {
  for (const [type, h] of Object.entries(overrides)) {
    if (!TYPE_NAME_RE.test(type)) throw new AppError('VALIDATION', `configureReviewSla(): invalid type "${type}"`);
    if (h === null) {
      slaOverrides.delete(type);
      continue;
    }
    assertSlaHours(type, h);
    slaOverrides.set(type, h);
  }
}

/** Reads `REVIEW_SLA_HOURS` as JSON `{"<type>": hours}` if present. */
export function loadReviewSlaFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env.REVIEW_SLA_HOURS;
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AppError('VALIDATION', 'REVIEW_SLA_HOURS must be a JSON object', undefined, { cause: e });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('VALIDATION', 'REVIEW_SLA_HOURS must be a JSON object');
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'number') throw new AppError('VALIDATION', `REVIEW_SLA_HOURS.${k} must be a number`);
    out[k] = v;
  }
  configureReviewSla(out);
}

export function slaHoursFor(def: AnyReviewTypeDef): number {
  return slaOverrides.get(def.type) ?? def.slaHours;
}

export function slaDueAt(def: AnyReviewTypeDef, from: Date = new Date()): Date {
  return new Date(from.getTime() + slaHoursFor(def) * 3_600_000);
}

/** Test helper. */
export function resetReviewRegistryForTesting(): void {
  types.clear();
  slaOverrides.clear();
}
