/**
 * M03 LLM adapter — public API. Other modules import ONLY from this file.
 *
 * IF-03a: complete(req), stream(req), and the `embed` extension (LLD assumption 2).
 * Provider-agnostic; used by both planes (the Python mirror lives in py/kp/m03_llm).
 */
export type { AnyTier, EmbedOptions, EmbedTier, LlmMessage, LlmRequest, LlmResult, LlmStream, LlmStreamChunk, Tier } from './types.js';
export { TEXT_TIERS } from './types.js';
export { LLM_BAD_OUTPUT, LlmBadOutputError, complete, costOp, embed, isLlmBadOutput, stream } from './adapter.js';
export {
  DEFAULT_LLM_CONFIG,
  buildLlmConfig,
  costMicrosInr,
  getLlmConfig,
  initLlmConfig,
  loadLlmConfig,
  setLlmConfigForTesting,
  validateLlmConfig,
} from './config.js';
export type { LlmConfig, ModelTarget, TierConfig } from './config.js';
export { CACHE_PREFIX, llmCacheKey, setLlmCacheClientForTesting } from './cache.js';
export { assertNoPii, detectPii } from './pii.js';
export type { PiiKind } from './pii.js';
export { extractJson, parseAndValidate, validateJson } from './jsonSchema.js';
export {
  ProviderHttpError,
  anthropicProvider,
  getLlmProvider,
  openaiProvider,
  registerLlmProvider,
  unregisterLlmProvider,
  voyageProvider,
} from './providers.js';
export type { LlmProvider, ProviderCall, ProviderCompletion, ProviderEmbedCall, ProviderEmbedding, ProviderStreamEvent } from './providers.js';
