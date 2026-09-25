/**
 * M01 — boot configuration and India-region guard.
 *
 * All environments (staging, production) run in a single India region so that user data
 * stays in India (DPDP, REQ-061/REQ-062) and latency to Indian users is low (REQ-057).
 * Boot fails closed if any region-bearing setting points outside India.
 *
 * Non-secret settings come from the process environment. Secrets (DB/Redis URLs, vendor
 * keys) come only from the secrets manager at boot — see secrets.ts.
 */
import { AppError } from './errors.js';
import type { AppEnv } from './types.js';

/** AWS regions physically located in India. ap-south-1 = Mumbai (primary), ap-south-2 = Hyderabad. */
export const INDIA_REGIONS: readonly string[] = Object.freeze(['ap-south-1', 'ap-south-2']);
export const PRIMARY_REGION = 'ap-south-1';

export interface PlatformConfig {
  appEnv: AppEnv;
  serviceName: string;
  /** Cloud region every data store and compute resource must live in. */
  region: string;
  /** Name/ARN of the secrets-manager secret holding the JSON secret bundle. */
  secretsId: string;
  /** Versioned S3 bucket for artefacts (exports, snapshots, uploads). */
  objectBucket: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /** OTLP endpoint for traces; tracing is a no-op when unset. */
  otlpEndpoint?: string;
  db: {
    poolMax: number;
    statementTimeoutMs: number;
  };
  cost: {
    flushIntervalMs: number;
    maxBufferedEvents: number;
  };
}

export function isIndiaRegion(region: string): boolean {
  return INDIA_REGIONS.includes(region.trim().toLowerCase());
}

/** Throws INTERNAL if a region is outside India. Used at boot for every region-bearing resource. */
export function assertIndiaRegion(region: string | undefined, what: string): string {
  if (!region || !isIndiaRegion(region)) {
    throw new AppError('INTERNAL', `${what} must be hosted in an India region (${INDIA_REGIONS.join(', ')}); got "${region ?? ''}"`, {
      what,
      region: region ?? null,
    });
  }
  return region.trim().toLowerCase();
}

const APP_ENVS: readonly AppEnv[] = ['local', 'test', 'staging', 'production'];
const LOG_LEVELS: readonly PlatformConfig['logLevel'][] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

function intFrom(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError('VALIDATION', `Config ${key} must be an integer in [${min}, ${max}]; got "${raw}"`, { key });
  }
  return n;
}

function required(env: NodeJS.ProcessEnv, key: string, appEnv: AppEnv, localDefault: string): string {
  const v = env[key];
  if (v !== undefined && v !== '') return v;
  if (appEnv === 'local' || appEnv === 'test') return localDefault;
  throw new AppError('VALIDATION', `Config ${key} is required in ${appEnv}`, { key });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const appEnvRaw = (env.APP_ENV ?? 'local') as AppEnv;
  if (!APP_ENVS.includes(appEnvRaw)) {
    throw new AppError('VALIDATION', `APP_ENV must be one of ${APP_ENVS.join(', ')}`, { value: env.APP_ENV });
  }
  const appEnv = appEnvRaw;

  // The region guard applies to every environment, including local: a developer pointing a
  // local build at a non-India bucket or database would still move data out of India.
  const region = assertIndiaRegion(env.AWS_REGION ?? PRIMARY_REGION, 'AWS_REGION');

  const logLevelRaw = (env.LOG_LEVEL ?? (appEnv === 'production' ? 'info' : 'debug')) as PlatformConfig['logLevel'];
  if (!LOG_LEVELS.includes(logLevelRaw)) {
    throw new AppError('VALIDATION', `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`, { value: env.LOG_LEVEL });
  }

  const cfg: PlatformConfig = {
    appEnv,
    serviceName: env.SERVICE_NAME ?? 'web',
    region,
    secretsId: required(env, 'SECRETS_ID', appEnv, `exportbuyers/${appEnv}/app`),
    objectBucket: required(env, 'OBJECT_BUCKET', appEnv, `exportbuyers-${appEnv}-objects`),
    logLevel: logLevelRaw,
    db: {
      poolMax: intFrom(env, 'DB_POOL_MAX', 20, 1, 500),
      statementTimeoutMs: intFrom(env, 'DB_STATEMENT_TIMEOUT_MS', 15_000, 100, 600_000),
    },
    cost: {
      // LLD IF-01b: buffered, flushed every 5 s. [tunable]
      flushIntervalMs: intFrom(env, 'COST_FLUSH_INTERVAL_MS', 5_000, 100, 600_000),
      maxBufferedEvents: intFrom(env, 'COST_MAX_BUFFERED_EVENTS', 10_000, 10, 1_000_000),
    },
  };
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) cfg.otlpEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return cfg;
}

let current: PlatformConfig | undefined;

export function initConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  current = loadConfig(env);
  return current;
}

export function getConfig(): PlatformConfig {
  if (!current) current = loadConfig();
  return current;
}
