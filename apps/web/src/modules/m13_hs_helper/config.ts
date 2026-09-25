/**
 * M13 HS helper — tunables (LLD M13, values marked [tunable]). Environment overrides are read
 * once, lazily; tests can replace the whole config with setHsHelperConfig().
 */
import { AppError } from '../m01_platform/index.js';

export interface HsHelperConfig {
  /** Candidates retrieved by vector search and shown to the reranker (LLD: k=30). */
  rerankK: number;
  /** Candidates returned to the client (LLD: top 5). */
  topN: number;
  /** Minimum reranked confidence to return a candidate (LLD: 0.15 [tunable]). */
  minConfidence: number;
  /** Free-text bounds (IF-13a: string(3..300)). */
  queryMinLength: number;
  queryMaxLength: number;
  /** Query-embedding cache TTL in Redis. */
  embedCacheTtlSec: number;
  /** Explanations longer than this are truncated. */
  explanationMaxLength: number;
  /** Candidate descriptions are truncated to this length in the rerank prompt. */
  promptDescriptionMaxLength: number;
}

export const DEFAULT_HS_HELPER_CONFIG: Readonly<HsHelperConfig> = Object.freeze({
  rerankK: 30,
  topN: 5,
  minConfidence: 0.15,
  queryMinLength: 3,
  queryMaxLength: 300,
  embedCacheTtlSec: 7 * 24 * 3600,
  explanationMaxLength: 400,
  promptDescriptionMaxLength: 300,
});

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number, integer: boolean): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    throw new AppError('INTERNAL', `${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`, { name });
  }
  return v;
}

export function loadHsHelperConfig(env: NodeJS.ProcessEnv = process.env): HsHelperConfig {
  const d = DEFAULT_HS_HELPER_CONFIG;
  const cfg: HsHelperConfig = {
    rerankK: num(env, 'M13_RERANK_K', d.rerankK, 5, 100, true),
    topN: num(env, 'M13_TOP_N', d.topN, 1, 20, true),
    minConfidence: num(env, 'M13_MIN_CONFIDENCE', d.minConfidence, 0, 1, false),
    queryMinLength: d.queryMinLength,
    queryMaxLength: d.queryMaxLength,
    embedCacheTtlSec: num(env, 'M13_EMBED_CACHE_TTL_SEC', d.embedCacheTtlSec, 60, 90 * 24 * 3600, true),
    explanationMaxLength: d.explanationMaxLength,
    promptDescriptionMaxLength: d.promptDescriptionMaxLength,
  };
  if (cfg.topN > cfg.rerankK) throw new AppError('INTERNAL', 'M13_TOP_N must not exceed M13_RERANK_K');
  return cfg;
}

let current: HsHelperConfig | undefined;

export function hsHelperConfig(): HsHelperConfig {
  if (!current) current = loadHsHelperConfig();
  return current;
}

/** Replace the config (tests); undefined re-reads the environment on next use. */
export function setHsHelperConfig(cfg: HsHelperConfig | undefined): void {
  current = cfg;
}
