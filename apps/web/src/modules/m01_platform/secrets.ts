/**
 * M01 — secrets. Read only from the secrets manager at boot; nothing is committed to the repo.
 *
 * The secret is a JSON object of string values, e.g.
 *   { "DATABASE_URL": "postgres://...", "REDIS_URL": "rediss://...", "VENDOR_X_API_KEY": "..." }
 *
 * In `local` and `test` environments only, missing secrets may be supplied through process
 * environment variables of the same name so developers can run without cloud credentials.
 * Staging and production never fall back to the environment.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { assertIndiaRegion, type PlatformConfig } from './config.js';
import { AppError } from './errors.js';

export type SecretName = 'DATABASE_URL' | 'REDIS_URL' | (string & {});

let secrets: Readonly<Record<string, string>> | undefined;
let devEnvFallback = false;

export interface SecretsSource {
  fetch(secretId: string, region: string): Promise<string>;
}

const awsSource: SecretsSource = {
  async fetch(secretId: string, region: string): Promise<string> {
    const client = new SecretsManagerClient({ region });
    try {
      const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      const s: unknown = out.SecretString;
      if (typeof s !== 'string' || s.length === 0) {
        throw new AppError('INTERNAL', `Secret ${secretId} has no SecretString`);
      }
      return s;
    } finally {
      client.destroy();
    }
  },
};

function parseBundle(raw: string, secretId: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AppError('INTERNAL', `Secret ${secretId} is not valid JSON`, undefined, { cause: e });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('INTERNAL', `Secret ${secretId} must be a JSON object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new AppError('INTERNAL', `Secret ${secretId} key ${k} must be a string`);
    out[k] = v;
  }
  return out;
}

/** Loads the secret bundle once at boot. */
export async function loadSecrets(cfg: PlatformConfig, source: SecretsSource = awsSource): Promise<void> {
  devEnvFallback = cfg.appEnv === 'local' || cfg.appEnv === 'test';
  const region = assertIndiaRegion(cfg.region, 'secrets manager region');
  try {
    const raw = await source.fetch(cfg.secretsId, region);
    secrets = Object.freeze(parseBundle(raw, cfg.secretsId));
  } catch (e) {
    if (!devEnvFallback) throw e;
    // local/test: no secrets manager available — rely on env fallback in getSecret().
    secrets = Object.freeze({});
  }
}

/** For tests: install an explicit secret bundle. */
export function setSecretsForTesting(bundle: Record<string, string>): void {
  secrets = Object.freeze({ ...bundle });
  devEnvFallback = true;
}

export function getSecret(name: SecretName): string {
  const v = secrets?.[name];
  if (v !== undefined && v !== '') return v;
  if (devEnvFallback) {
    const e = process.env[name];
    if (e !== undefined && e !== '') return e;
  }
  if (!secrets) throw new AppError('INTERNAL', 'Secrets have not been loaded; call loadSecrets() at boot');
  throw new AppError('INTERNAL', `Secret ${name} is not configured`);
}

export function hasSecret(name: SecretName): boolean {
  try {
    getSecret(name);
    return true;
  } catch {
    return false;
  }
}
