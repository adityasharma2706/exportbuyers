/**
 * M10 — IF-10b provider registry and tunables.
 *
 *   userHides     filled by the per-user hide feature (REQ-025)
 *   entitlements  filled by M36 (IF-36c; it caches for 60 s itself) — until then the actor
 *                 context's entitlements (M28 Free defaults) are used
 *
 * Sanctions and logistics need no provider: they are read from the doc fields
 * `sanctions_block` / `is_logistics` that M09 projects from M17 / M19 assertions.
 */
import { AppError, log, type ActorContext, type Entitlements } from '../m01_platform/index.js';
import type { EntitlementsProvider, ProviderKind, UserHidesProvider } from './types.js';

export interface PolicyConfig {
  /** Rule 7: rows an anonymous visitor sees on search [tunable]. */
  anonymousSearchCap: number;
  /** Share of decisions written to serving.policy_audit (denies on reveal/draft/export always are) [tunable]. */
  auditSampleRate: number;
  /** Search result cache lifetime in seconds [tunable]. */
  searchCacheTtlSec: number;
}

const DEFAULT_CONFIG: PolicyConfig = { anonymousSearchCap: 5, auditSampleRate: 0.01, searchCacheTtlSec: 60 };
let config: PolicyConfig = { ...DEFAULT_CONFIG };

function envNumber(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Reads M10_ANON_SEARCH_CAP, M10_AUDIT_SAMPLE_RATE and M10_SEARCH_CACHE_TTL_SEC. */
export function loadPolicyConfigFromEnv(): PolicyConfig {
  return configurePolicy({
    anonymousSearchCap: envNumber('M10_ANON_SEARCH_CAP') ?? DEFAULT_CONFIG.anonymousSearchCap,
    auditSampleRate: envNumber('M10_AUDIT_SAMPLE_RATE') ?? DEFAULT_CONFIG.auditSampleRate,
    searchCacheTtlSec: envNumber('M10_SEARCH_CACHE_TTL_SEC') ?? DEFAULT_CONFIG.searchCacheTtlSec,
  });
}

export function configurePolicy(patch: Partial<PolicyConfig>): PolicyConfig {
  const next = { ...config, ...patch };
  if (!Number.isInteger(next.anonymousSearchCap) || next.anonymousSearchCap < 0) {
    throw new AppError('VALIDATION', 'anonymousSearchCap must be a non-negative integer');
  }
  if (!(next.auditSampleRate >= 0 && next.auditSampleRate <= 1)) {
    throw new AppError('VALIDATION', 'auditSampleRate must be between 0 and 1');
  }
  if (!Number.isInteger(next.searchCacheTtlSec) || next.searchCacheTtlSec < 0) {
    throw new AppError('VALIDATION', 'searchCacheTtlSec must be a non-negative integer');
  }
  config = next;
  return config;
}

export function policyConfig(): PolicyConfig {
  return config;
}

let userHides: UserHidesProvider | undefined;
let entitlements: EntitlementsProvider | undefined;

/** IF-10b. Registering a kind again replaces the previous provider. */
export function registerProvider(kind: 'userHides', p: UserHidesProvider): void;
export function registerProvider(kind: 'entitlements', p: EntitlementsProvider): void;
export function registerProvider(kind: ProviderKind, p: UserHidesProvider | EntitlementsProvider): void {
  if (kind === 'userHides') {
    const h = p as UserHidesProvider;
    if (typeof h?.hiddenCompanies !== 'function' || typeof h?.hiddenAssertions !== 'function') {
      throw new AppError('VALIDATION', 'userHides provider must implement hiddenCompanies and hiddenAssertions');
    }
    userHides = h;
  } else if (kind === 'entitlements') {
    const e = p as EntitlementsProvider;
    if (typeof e?.get !== 'function') throw new AppError('VALIDATION', 'entitlements provider must implement get');
    entitlements = e;
  } else {
    throw new AppError('VALIDATION', `Unknown provider kind "${String(kind)}"`);
  }
}

/** Test hook. */
export function resetProvidersForTesting(): void {
  userHides = undefined;
  entitlements = undefined;
  config = { ...DEFAULT_CONFIG };
}

export interface UserHides {
  companies: Set<string>;
  assertions: Set<string>;
}

const NO_HIDES: UserHides = Object.freeze({ companies: new Set<string>(), assertions: new Set<string>() }) as UserHides;

/**
 * The actor's hides. Anonymous and system actors have none. A provider failure is an error:
 * showing a company the user asked to hide is a visible policy breach, so the read fails
 * rather than silently ignoring the hide.
 */
export async function userHidesFor(ctx: ActorContext): Promise<UserHides> {
  if (!userHides || !ctx.accountId || ctx.kind === 'anonymous') return NO_HIDES;
  try {
    const [companies, assertions] = await Promise.all([
      userHides.hiddenCompanies(ctx.accountId),
      userHides.hiddenAssertions(ctx.accountId),
    ]);
    return { companies: new Set(companies), assertions: new Set(assertions) };
  } catch (err) {
    log.error({ err, correlationId: ctx.correlationId }, 'm10 userHides provider failed');
    throw new AppError('UPSTREAM_UNAVAILABLE', 'Hidden-company preferences are unavailable', undefined, { cause: err });
  }
}

/** REQ-051 entitlement hook: the provider's answer, else the actor context's entitlements. */
export async function entitlementsFor(ctx: ActorContext): Promise<Entitlements> {
  if (ctx.kind === 'anonymous') return ctx.entitlements;
  if (!entitlements) return ctx.entitlements;
  try {
    return await entitlements.get(ctx.accountId ?? null);
  } catch (err) {
    log.warn({ err, correlationId: ctx.correlationId }, 'm10 entitlements provider failed; using context entitlements');
    return ctx.entitlements;
  }
}
