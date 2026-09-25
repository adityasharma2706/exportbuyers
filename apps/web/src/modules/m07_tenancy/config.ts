/**
 * M07 — tunable limits (LLD M07 Rules: at most 20 countries per workspace and 25 workspaces
 * per account [tunable]; soft-deleted workspaces are hard-purged after 30 days).
 */
export interface TenancyConfig {
  maxCountriesPerWorkspace: number;
  maxWorkspacesPerAccount: number;
  /** Also bounded by the DB check (20); the app limit may be lowered, not raised. */
  maxTargetMarkets: number;
  workspaceNameMaxLength: number;
  purgeAfterDays: number;
  /** Stored idempotent responses are kept this long. */
  idempotencyTtlHours: number;
}

const DEFAULTS: TenancyConfig = Object.freeze({
  maxCountriesPerWorkspace: 20,
  maxWorkspacesPerAccount: 25,
  maxTargetMarkets: 20,
  workspaceNameMaxLength: 60,
  purgeAfterDays: 30,
  idempotencyTtlHours: 24,
});

let current: TenancyConfig = { ...DEFAULTS };

function positiveInt(v: string | undefined, fallback: number, max?: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return max !== undefined ? Math.min(n, max) : n;
}

export function loadTenancyConfig(env: Record<string, string | undefined> = process.env): TenancyConfig {
  current = {
    // The DB check constraints cap arrays at 20, so the tunables may only lower that bound.
    maxCountriesPerWorkspace: positiveInt(env.M07_MAX_COUNTRIES_PER_WORKSPACE, DEFAULTS.maxCountriesPerWorkspace, 20),
    maxWorkspacesPerAccount: positiveInt(env.M07_MAX_WORKSPACES_PER_ACCOUNT, DEFAULTS.maxWorkspacesPerAccount),
    maxTargetMarkets: positiveInt(env.M07_MAX_TARGET_MARKETS, DEFAULTS.maxTargetMarkets, 20),
    workspaceNameMaxLength: DEFAULTS.workspaceNameMaxLength,
    purgeAfterDays: positiveInt(env.M07_PURGE_AFTER_DAYS, DEFAULTS.purgeAfterDays),
    idempotencyTtlHours: positiveInt(env.M07_IDEMPOTENCY_TTL_HOURS, DEFAULTS.idempotencyTtlHours),
  };
  return current;
}

export function tenancyConfig(): TenancyConfig {
  return current;
}

/** For tests. */
export function setTenancyConfig(patch: Partial<TenancyConfig>): void {
  current = { ...current, ...patch };
}
