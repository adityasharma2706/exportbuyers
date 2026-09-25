/**
 * M03 LLM adapter — public types (IF-03a).
 *
 *   type Tier = 'classify' | 'draft'
 *   complete(req: LlmRequest): Promise<LlmResult>
 *   stream(req: LlmRequest): AsyncIterable<{delta: string}> & { final: Promise<LlmResult> }
 *
 * Extension (LLD assumption 2, M12 / M48): an `embed` tier and `embed(texts)`.
 */
import type { ActorContext } from '../m01_platform/index.js';

/** Text-generation tiers. Mapped to a concrete provider/model in config: llm.tiers.<tier>. */
export type Tier = 'classify' | 'draft';

/** Embedding tier (LLD extension to IF-03a). */
export type EmbedTier = 'embed';

export type AnyTier = Tier | EmbedTier;

export const TEXT_TIERS: readonly Tier[] = Object.freeze(['classify', 'draft'] as Tier[]);

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  tier: Tier;
  /** Short machine name of the call site, e.g. "m15.page_classify". Used as the cost `op` and in logs. */
  purpose: string;
  system: string;
  messages: LlmMessage[];
  /** When present the adapter runs in structured-output mode and validates the reply against this schema. */
  jsonSchema?: object;
  temperature?: number;
  /** Only `cacheable: true` requests read from or write to the response cache. */
  cacheable?: boolean;
  /**
   * The caller asserts the prompt contains no personal data. Only then are prompt and output logged,
   * and a regex guard rejects the request if it contains email or phone patterns.
   */
  piiFree: boolean;
  ctx?: ActorContext;
  timeoutMs?: number;
}

export interface LlmResult {
  text: string;
  /** Parsed and schema-validated JSON when the request had a `jsonSchema`. */
  json?: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
}

export interface LlmStreamChunk {
  delta: string;
}

/** Single-consumer stream. `final` settles even if the stream is never iterated. */
export type LlmStream = AsyncIterable<LlmStreamChunk> & { final: Promise<LlmResult> };

export interface EmbedOptions {
  /** Cost `op` and log label. Defaults to "embed". */
  purpose?: string;
  /** Defaults to true: embedding inputs are catalogue/product texts. The PII guard applies when true. */
  piiFree?: boolean;
  ctx?: ActorContext;
  /** Per-batch timeout. */
  timeoutMs?: number;
}
