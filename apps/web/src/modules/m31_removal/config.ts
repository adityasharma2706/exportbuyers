/**
 * M31 — tunables (LLD M31 Rules: "Target SLA: 72 h", "a verification email with a 24 h token").
 */
import { AppError } from '../m01_platform/index.js';

export interface RemovalConfig {
  /** LLD M31 API: "a verification email with a 24 h token is sent." [tunable] */
  challengeTtlHours: number;
  /** Origin used to build the verification link sent by email, e.g. https://app.exportbuyers.in.
   * No trailing slash. */
  publicBaseUrl: string;
  /** How long a consumed/expired challenge row is kept before `m31.purge_expired_challenges`
   * deletes it (for support/audit lookups). [tunable] */
  challengeRetentionDays: number;
}

const DEFAULT_CONFIG: RemovalConfig = {
  challengeTtlHours: 24,
  publicBaseUrl: 'http://localhost:3000',
  challengeRetentionDays: 30,
};

let config: RemovalConfig = { ...DEFAULT_CONFIG };

function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const v = env[name];
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

export function setRemovalConfig(patch: Partial<RemovalConfig>): RemovalConfig {
  const next = { ...config, ...patch };
  if (!Number.isInteger(next.challengeTtlHours) || next.challengeTtlHours < 1 || next.challengeTtlHours > 24 * 30) {
    throw new AppError('VALIDATION', 'challengeTtlHours must be an integer number of hours in [1, 720]');
  }
  if (!Number.isInteger(next.challengeRetentionDays) || next.challengeRetentionDays < 1) {
    throw new AppError('VALIDATION', 'challengeRetentionDays must be a positive integer');
  }
  if (typeof next.publicBaseUrl !== 'string' || next.publicBaseUrl.trim() === '') {
    throw new AppError('VALIDATION', 'publicBaseUrl is required');
  }
  try {
    const u = new URL(next.publicBaseUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)');
  } catch (e) {
    throw new AppError('VALIDATION', 'publicBaseUrl must be a valid http(s) URL', undefined, { cause: e });
  }
  config = { ...next, publicBaseUrl: next.publicBaseUrl.replace(/\/+$/, '') };
  return config;
}

/** Reads M31_CHALLENGE_TTL_HOURS, M31_PUBLIC_BASE_URL, M31_CHALLENGE_RETENTION_DAYS. */
export function loadRemovalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RemovalConfig {
  const appEnv = env.APP_ENV ?? 'local';
  const isDev = appEnv === 'local' || appEnv === 'test';
  const base = env.M31_PUBLIC_BASE_URL ?? (isDev ? DEFAULT_CONFIG.publicBaseUrl : '');
  if (!base) throw new AppError('VALIDATION', 'M31_PUBLIC_BASE_URL is required outside local/test');
  return setRemovalConfig({
    challengeTtlHours: envInt(env, 'M31_CHALLENGE_TTL_HOURS') ?? DEFAULT_CONFIG.challengeTtlHours,
    publicBaseUrl: base,
    challengeRetentionDays: envInt(env, 'M31_CHALLENGE_RETENTION_DAYS') ?? DEFAULT_CONFIG.challengeRetentionDays,
  });
}

export function removalConfig(): RemovalConfig {
  return config;
}

/** Test hook. */
export function resetRemovalConfigForTesting(): void {
  config = { ...DEFAULT_CONFIG };
}
