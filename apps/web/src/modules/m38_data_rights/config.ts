/**
 * M38 — tunables (LLD M38 "Rules": "Zip the results to S3 and keep them 7 days; the download
 * link is pre-signed for 24 h").
 */
export interface DataRightsConfig {
  /** LLD: "keep them 7 days" — an S3 lifecycle rule (infra, like M35's own exports) deletes the
   * object after this many days; this value only feeds the object's Expires metadata. */
  exportRetentionDays: number;
  /** LLD: "the download link is pre-signed for 24 h". */
  presignExpirySeconds: number;
  keyPrefix: string;
}

const DEFAULTS: DataRightsConfig = Object.freeze({
  exportRetentionDays: 7,
  presignExpirySeconds: 24 * 60 * 60,
  keyPrefix: 'rights-export',
});

let current: DataRightsConfig = { ...DEFAULTS };

function positiveInt(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadDataRightsConfig(env: Record<string, string | undefined> = process.env): DataRightsConfig {
  current = {
    exportRetentionDays: positiveInt(env.M38_EXPORT_RETENTION_DAYS, DEFAULTS.exportRetentionDays),
    presignExpirySeconds: positiveInt(env.M38_PRESIGN_EXPIRY_SECONDS, DEFAULTS.presignExpirySeconds),
    keyPrefix: env.M38_KEY_PREFIX && env.M38_KEY_PREFIX.trim() ? env.M38_KEY_PREFIX.trim() : DEFAULTS.keyPrefix,
  };
  return current;
}

export function dataRightsConfig(): DataRightsConfig {
  return current;
}

/** For tests. */
export function setDataRightsConfig(patch: Partial<DataRightsConfig>): void {
  current = { ...current, ...patch };
}

export const EXPORT_JOB_TYPE = 'm38.export';
export const ERASE_JOB_TYPE = 'm38.erase';
export const RIGHTS_JOB_QUEUE = 'serving' as const;
export const RIGHTS_RATE_CLASS = 'm38.rights';

/** LLD Rules step 5: "Target completion: 30 days. In practice this is immediate, with jobs
 * retrying on failure." — a generous max_attempts so the erase keeps retrying across that window
 * rather than dead-lettering on the first transient failure (e.g. Razorpay/LLM being down). */
export const ERASE_MAX_ATTEMPTS = 40;
export const EXPORT_MAX_ATTEMPTS = 10;
