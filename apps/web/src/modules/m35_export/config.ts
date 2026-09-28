/**
 * M35 — tunables (LLD M35 API/Job).
 */
export interface ExportConfig {
  /** LLD M35 schema: "expires_at (+7 d)". S3 lifecycle deletes the object after the same span. */
  expiresAfterDays: number;
  /** LLD M35 API: "downloadUrl? (S3 pre-signed, 15 min)". */
  presignExpirySeconds: number;
  /** Object key prefix inside the one shared object store bucket (see types.ts deviation note). */
  keyPrefix: string;
}

const DEFAULTS: ExportConfig = Object.freeze({
  expiresAfterDays: 7,
  presignExpirySeconds: 15 * 60,
  keyPrefix: 'exports',
});

let current: ExportConfig = { ...DEFAULTS };

function positiveInt(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadExportConfig(env: Record<string, string | undefined> = process.env): ExportConfig {
  current = {
    expiresAfterDays: positiveInt(env.M35_EXPIRES_AFTER_DAYS, DEFAULTS.expiresAfterDays),
    presignExpirySeconds: positiveInt(env.M35_PRESIGN_EXPIRY_SECONDS, DEFAULTS.presignExpirySeconds),
    keyPrefix: env.M35_KEY_PREFIX && env.M35_KEY_PREFIX.trim() ? env.M35_KEY_PREFIX.trim() : DEFAULTS.keyPrefix,
  };
  return current;
}

export function exportConfig(): ExportConfig {
  return current;
}

/** For tests. */
export function setExportConfig(patch: Partial<ExportConfig>): void {
  current = { ...current, ...patch };
}

export const BUILD_JOB_TYPE = 'm35.build';
export const BUILD_JOB_QUEUE = 'serving' as const;
export const BUILD_RATE_CLASS = 'm35.build';

/** LLD Job m35.build step 4: the "hidden sheet with the account id" name (xlsx only). */
export const META_SHEET_NAME = '_meta';

/** LLD Job m35.build step 4: one synthetic company per export, tied to the account (honeypot). */
export const CANARY_EMAIL_DOMAIN = 'canary.exportbuyers.invalid';
