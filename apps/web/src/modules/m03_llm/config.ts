/**
 * M03 — tier configuration: llm.tiers.<tier> = {provider, model, maxTokens, fallback?}.
 *
 * M01's PlatformConfig has no `llm` section, so the tier map is loaded here from the
 * `LLM_CONFIG` environment variable (JSON, partial overrides merged per tier over the
 * defaults below). Prices are [tunable] and are used only to compute `costMicrosInr`
 * for recordCost; `units` is always the token count.
 */
import { AppError } from '../m01_platform/index.js';
import type { AnyTier } from './types.js';

export interface ModelTarget {
  /** Provider name; must be registered in providers.ts (anthropic, openai, voyage, or a custom one). */
  provider: string;
  model: string;
  maxTokens: number;
  /** Override for the provider API base URL (e.g. a regional or proxy endpoint). */
  baseUrl?: string;
  /** Price per million input tokens, in micro-INR. */
  inputMicrosInrPerMTok: number;
  /** Price per million output tokens, in micro-INR. */
  outputMicrosInrPerMTok: number;
}

export interface TierConfig extends ModelTarget {
  fallback?: ModelTarget;
  /** Default timeout for a call on this tier. */
  timeoutMs: number;
  /** Temperature used when the request does not set one. */
  defaultTemperature: number;
  /** Embedding tier only: expected vector length. */
  dimensions?: number;
}

export interface LlmConfig {
  tiers: Record<AnyTier, TierConfig>;
  /** Response cache TTL (LLD M03: 30 days). */
  cacheTtlSec: number;
  /** Texts per embedding request (LLD M12: 128). */
  embedBatchSize: number;
  /** Max characters of prompt/output written to logs for piiFree calls. */
  logMaxChars: number;
}

// ~84 INR per USD [tunable]; list prices per million tokens.
const INR_MICROS_PER_USD = 84_000_000;

export const DEFAULT_LLM_CONFIG: LlmConfig = Object.freeze({
  tiers: {
    classify: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      maxTokens: 1024,
      inputMicrosInrPerMTok: 1 * INR_MICROS_PER_USD,
      outputMicrosInrPerMTok: 5 * INR_MICROS_PER_USD,
      timeoutMs: 20_000,
      defaultTemperature: 0,
    },
    draft: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      maxTokens: 4096,
      inputMicrosInrPerMTok: 3 * INR_MICROS_PER_USD,
      outputMicrosInrPerMTok: 15 * INR_MICROS_PER_USD,
      timeoutMs: 60_000,
      defaultTemperature: 0.7,
    },
    embed: {
      provider: 'voyage',
      model: 'voyage-3',
      maxTokens: 0,
      inputMicrosInrPerMTok: Math.round(0.06 * INR_MICROS_PER_USD),
      outputMicrosInrPerMTok: 0,
      timeoutMs: 20_000,
      defaultTemperature: 0,
      dimensions: 1024,
    },
  },
  cacheTtlSec: 30 * 24 * 3600,
  embedBatchSize: 128,
  logMaxChars: 8000,
}) as LlmConfig;

const TIERS: readonly AnyTier[] = ['classify', 'draft', 'embed'];
const PROVIDER_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonNegInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new AppError('VALIDATION', `LLM config: ${what} must be a non-negative integer`);
  }
  return v;
}

function validateTarget(t: ModelTarget, what: string, isEmbed: boolean): void {
  if (typeof t.provider !== 'string' || !PROVIDER_RE.test(t.provider)) {
    throw new AppError('VALIDATION', `LLM config: ${what}.provider must match ${PROVIDER_RE.source}`);
  }
  if (typeof t.model !== 'string' || t.model.length === 0) {
    throw new AppError('VALIDATION', `LLM config: ${what}.model is required`);
  }
  nonNegInt(t.maxTokens, `${what}.maxTokens`);
  if (!isEmbed && t.maxTokens < 1) throw new AppError('VALIDATION', `LLM config: ${what}.maxTokens must be >= 1`);
  nonNegInt(t.inputMicrosInrPerMTok, `${what}.inputMicrosInrPerMTok`);
  nonNegInt(t.outputMicrosInrPerMTok, `${what}.outputMicrosInrPerMTok`);
  if (t.baseUrl !== undefined) {
    try {
      const u = new URL(t.baseUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    } catch {
      throw new AppError('VALIDATION', `LLM config: ${what}.baseUrl is not a valid http(s) URL`);
    }
  }
}

export function validateLlmConfig(cfg: LlmConfig): LlmConfig {
  for (const tier of TIERS) {
    const t = cfg.tiers[tier];
    if (!t) throw new AppError('VALIDATION', `LLM config: tier "${tier}" is missing`);
    const isEmbed = tier === 'embed';
    validateTarget(t, `tiers.${tier}`, isEmbed);
    if (t.fallback) validateTarget(t.fallback, `tiers.${tier}.fallback`, isEmbed);
    if (nonNegInt(t.timeoutMs, `tiers.${tier}.timeoutMs`) < 100) {
      throw new AppError('VALIDATION', `LLM config: tiers.${tier}.timeoutMs must be >= 100`);
    }
    if (typeof t.defaultTemperature !== 'number' || t.defaultTemperature < 0 || t.defaultTemperature > 2) {
      throw new AppError('VALIDATION', `LLM config: tiers.${tier}.defaultTemperature must be in [0, 2]`);
    }
    if (isEmbed && (t.dimensions === undefined || nonNegInt(t.dimensions, 'tiers.embed.dimensions') < 1)) {
      throw new AppError('VALIDATION', 'LLM config: tiers.embed.dimensions must be >= 1');
    }
  }
  if (nonNegInt(cfg.cacheTtlSec, 'cacheTtlSec') < 1) throw new AppError('VALIDATION', 'LLM config: cacheTtlSec must be >= 1');
  const b = nonNegInt(cfg.embedBatchSize, 'embedBatchSize');
  if (b < 1 || b > 2048) throw new AppError('VALIDATION', 'LLM config: embedBatchSize must be in [1, 2048]');
  nonNegInt(cfg.logMaxChars, 'logMaxChars');
  return cfg;
}

function mergeTarget(base: ModelTarget | undefined, patch: unknown): ModelTarget | undefined {
  if (patch === null) return undefined;
  if (!isObj(patch)) return base;
  return { ...(base ?? ({} as ModelTarget)), ...(patch as unknown as Partial<ModelTarget>) } as ModelTarget;
}

/** Merges a partial override (the parsed LLM_CONFIG JSON) over the defaults and validates the result. */
export function buildLlmConfig(override: unknown): LlmConfig {
  const base = DEFAULT_LLM_CONFIG;
  const out: LlmConfig = {
    tiers: {
      classify: { ...base.tiers.classify },
      draft: { ...base.tiers.draft },
      embed: { ...base.tiers.embed },
    },
    cacheTtlSec: base.cacheTtlSec,
    embedBatchSize: base.embedBatchSize,
    logMaxChars: base.logMaxChars,
  };
  if (override !== undefined) {
    if (!isObj(override)) throw new AppError('VALIDATION', 'LLM_CONFIG must be a JSON object');
    const tiers = override.tiers;
    if (tiers !== undefined) {
      if (!isObj(tiers)) throw new AppError('VALIDATION', 'LLM_CONFIG.tiers must be an object');
      for (const [name, patch] of Object.entries(tiers)) {
        if (!(TIERS as readonly string[]).includes(name)) {
          throw new AppError('VALIDATION', `LLM_CONFIG.tiers: unknown tier "${name}"`);
        }
        if (!isObj(patch)) throw new AppError('VALIDATION', `LLM_CONFIG.tiers.${name} must be an object`);
        const tier = name as AnyTier;
        const current = out.tiers[tier];
        const { fallback, ...rest } = patch;
        const merged: TierConfig = { ...current, ...(rest as unknown as Partial<TierConfig>) };
        if ('fallback' in patch) {
          const fb = mergeTarget(current.fallback, fallback);
          if (fb) merged.fallback = fb;
          else delete merged.fallback;
        }
        out.tiers[tier] = merged;
      }
    }
    if (override.cacheTtlSec !== undefined) out.cacheTtlSec = override.cacheTtlSec as number;
    if (override.embedBatchSize !== undefined) out.embedBatchSize = override.embedBatchSize as number;
    if (override.logMaxChars !== undefined) out.logMaxChars = override.logMaxChars as number;
  }
  return validateLlmConfig(out);
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const raw = env.LLM_CONFIG;
  if (raw === undefined || raw.trim() === '') return buildLlmConfig(undefined);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AppError('VALIDATION', 'LLM_CONFIG is not valid JSON', undefined, { cause: e });
  }
  return buildLlmConfig(parsed);
}

let current: LlmConfig | undefined;

export function initLlmConfig(cfg?: LlmConfig): LlmConfig {
  current = cfg ? validateLlmConfig(cfg) : loadLlmConfig();
  return current;
}

export function getLlmConfig(): LlmConfig {
  if (!current) current = loadLlmConfig();
  return current;
}

/** For tests: install (or clear, with undefined) an explicit config. */
export function setLlmConfigForTesting(cfg: LlmConfig | undefined): void {
  current = cfg ? validateLlmConfig(cfg) : undefined;
}

/** Integer micro-INR cost of a call. */
export function costMicrosInr(target: ModelTarget, inputTokens: number, outputTokens: number): number {
  const c = (inputTokens * target.inputMicrosInrPerMTok + outputTokens * target.outputMicrosInrPerMTok) / 1_000_000;
  return Math.max(0, Math.round(c));
}
