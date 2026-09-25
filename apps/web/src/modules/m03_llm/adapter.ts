/**
 * M03 — the LLM adapter (IF-03a): complete(), stream(), embed().
 *
 * Rules implemented (LLD M03):
 *  - Tier → provider/model from config (llm.tiers.<tier>).
 *  - Cache: sha256(tier|model|system|messages|jsonSchema|temperature), only for cacheable requests, Redis TTL 30 d.
 *  - jsonSchema → structured-output mode; on an invalid reply retry once with the validation error appended;
 *    a second failure throws LLM_BAD_OUTPUT (AppError INTERNAL, retryable inside jobs).
 *  - Logging: prompt and output only when piiFree; otherwise purpose, token counts and hashes.
 *  - recordCost({vendor: provider, op: purpose, units: tokens}) for every provider call.
 *  - Timeouts 20 s classify / 60 s draft; on timeout or 5xx retry once on the tier's fallback, else UPSTREAM_UNAVAILABLE.
 *  - piiFree prompts are rejected if they contain email or phone patterns.
 */
import { AppError, currentLogContext, log, recordCost, withSpan } from '../m01_platform/index.js';
import { cacheGet, cachePut, llmCacheKey } from './cache.js';
import { costMicrosInr, getLlmConfig } from './config.js';
import type { ModelTarget, TierConfig } from './config.js';
import { parseAndValidate } from './jsonSchema.js';
import { assertNoPii, sha256Hex, stableStringify } from './pii.js';
import { ProviderHttpError, getLlmProvider } from './providers.js';
import type { ProviderCall, ProviderCompletion } from './providers.js';
import { TEXT_TIERS } from './types.js';
import type { EmbedOptions, LlmMessage, LlmRequest, LlmResult, LlmStream, LlmStreamChunk } from './types.js';

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

export const LLM_BAD_OUTPUT = 'LLM_BAD_OUTPUT';

/**
 * The model's output failed schema validation twice. Maps to INTERNAL for the API; it is a
 * plain (retryable) error for M02 job handlers, i.e. not NonRetryable.
 */
export class LlmBadOutputError extends AppError {
  readonly llmCode = LLM_BAD_OUTPUT;
  readonly retryable = true;
  constructor(purpose: string, validationError: string) {
    super('INTERNAL', `${LLM_BAD_OUTPUT}: model output failed schema validation`, {
      llmCode: LLM_BAD_OUTPUT,
      purpose,
      validationError: validationError.slice(0, 500),
    });
    this.name = 'LlmBadOutputError';
  }
}

export function isLlmBadOutput(e: unknown): e is LlmBadOutputError {
  return e instanceof LlmBadOutputError;
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM call timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Timeouts, network errors and 5xx are eligible for the fallback provider. */
function isFallbackEligible(e: unknown): boolean {
  if (e instanceof TimeoutError) return true;
  if (e instanceof ProviderHttpError) return e.status === 0 || e.status >= 500;
  return false;
}

function mapProviderError(e: unknown, purpose: string, provider: string): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof TimeoutError || (e instanceof ProviderHttpError && (e.status === 0 || e.status >= 500 || e.status === 429))) {
    return new AppError('UPSTREAM_UNAVAILABLE', 'The language model service is unavailable', { purpose, provider }, { cause: e });
  }
  if (e instanceof ProviderHttpError) {
    // 4xx other than 429: our request was rejected — a programming/config error.
    return new AppError('INTERNAL', `LLM provider rejected the request (HTTP ${e.status})`, { purpose, provider }, { cause: e });
  }
  return new AppError('INTERNAL', 'LLM call failed', { purpose, provider }, { cause: e });
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/** Cost `op` from the free-form purpose: lowercase, invalid chars → "_", ≤ 64 chars. */
export function costOp(purpose: string): string {
  let s = purpose.toLowerCase().replace(/[^a-z0-9_.:-]/g, '_');
  if (!/^[a-z0-9]/.test(s)) s = `p${s}`;
  s = s.slice(0, 64);
  return NAME_RE.test(s) ? s : 'llm';
}

function validateRequest(req: LlmRequest): void {
  if (!req || typeof req !== 'object') throw new AppError('VALIDATION', 'LLM request is required');
  if (!(TEXT_TIERS as readonly string[]).includes(req.tier)) {
    throw new AppError('VALIDATION', `Unknown LLM tier "${String(req.tier)}"`);
  }
  if (typeof req.purpose !== 'string' || req.purpose.trim().length === 0) {
    throw new AppError('VALIDATION', 'LLM request purpose is required');
  }
  if (typeof req.system !== 'string') throw new AppError('VALIDATION', 'LLM request system must be a string');
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new AppError('VALIDATION', 'LLM request needs at least one message', { purpose: req.purpose });
  }
  for (const m of req.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw new AppError('VALIDATION', 'LLM messages must be {role: user|assistant, content: string}', { purpose: req.purpose });
    }
  }
  if (req.messages[0]?.role !== 'user') {
    throw new AppError('VALIDATION', 'The first LLM message must have role "user"', { purpose: req.purpose });
  }
  if (typeof req.piiFree !== 'boolean') {
    throw new AppError('VALIDATION', 'LLM request must declare piiFree', { purpose: req.purpose });
  }
  if (req.temperature !== undefined && (typeof req.temperature !== 'number' || req.temperature < 0 || req.temperature > 2)) {
    throw new AppError('VALIDATION', 'LLM temperature must be in [0, 2]', { purpose: req.purpose });
  }
  if (req.timeoutMs !== undefined && (!Number.isFinite(req.timeoutMs) || req.timeoutMs < 100)) {
    throw new AppError('VALIDATION', 'LLM timeoutMs must be >= 100', { purpose: req.purpose });
  }
  if (req.jsonSchema !== undefined && (req.jsonSchema === null || typeof req.jsonSchema !== 'object')) {
    throw new AppError('VALIDATION', 'LLM jsonSchema must be an object', { purpose: req.purpose });
  }
  if (req.piiFree) assertNoPii(req.purpose, [req.system, ...req.messages.map((m) => m.content)]);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

function promptHash(req: LlmRequest): string {
  return sha256Hex(stableStringify({ system: req.system, messages: req.messages }));
}

interface CallOutcome {
  provider: string;
  latencyMs: number;
  fellBack: boolean;
}

function logCall(req: LlmRequest, result: LlmResult, outcome: CallOutcome | undefined, extra: Record<string, unknown> = {}): void {
  const base: Record<string, unknown> = {
    purpose: req.purpose,
    tier: req.tier,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cached: result.cached,
    ...(outcome ? { provider: outcome.provider, latencyMs: outcome.latencyMs, fellBack: outcome.fellBack } : {}),
    ...extra,
  };
  if (req.piiFree) {
    const max = getLlmConfig().logMaxChars;
    base.prompt = {
      system: truncate(req.system, max),
      messages: req.messages.map((m) => ({ role: m.role, content: truncate(m.content, max) })),
    };
    base.output = truncate(result.text, max);
  } else {
    // Draft prompts carry the user's business details: log hashes only.
    base.promptHash = promptHash(req);
    base.outputHash = sha256Hex(result.text);
  }
  log.info({ llm: base }, 'llm call');
}

function recordLlmCost(req: { purpose: string; ctx?: LlmRequest['ctx'] }, target: ModelTarget, inputTokens: number, outputTokens: number): void {
  const jobType = currentLogContext()?.jobType;
  try {
    recordCost({
      vendor: target.provider,
      op: costOp(req.purpose),
      units: inputTokens + outputTokens,
      costMicrosInr: costMicrosInr(target, inputTokens, outputTokens),
      ...(req.ctx ? { ctx: req.ctx } : {}),
      ...(jobType && NAME_RE.test(jobType) ? { jobType } : {}),
    });
  } catch (err) {
    // The provider has already been paid; never lose the output because of a cost-recording bug.
    log.error({ err, purpose: req.purpose, vendor: target.provider }, 'llm cost recording failed');
  }
}

/** Rough token estimate (≈4 chars/token) used only when a provider omits usage. */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

async function withTimeout<T>(ms: number, parent: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, ms);
  const onParent = (): void => ac.abort();
  parent?.addEventListener('abort', onParent, { once: true });
  try {
    return await fn(ac.signal);
  } catch (e) {
    if (timedOut) throw new TimeoutError(ms);
    throw e;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParent);
  }
}

function targets(tier: TierConfig): ModelTarget[] {
  return tier.fallback ? [tier, tier.fallback] : [tier];
}

function providerCall(target: ModelTarget, req: LlmRequest, messages: LlmMessage[], temperature: number, signal: AbortSignal): ProviderCall {
  return {
    model: target.model,
    maxTokens: target.maxTokens,
    system: req.system,
    messages,
    temperature,
    ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}),
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    signal,
  };
}

/** One logical completion: primary target, then (on timeout/5xx) the fallback once. */
async function completeWithFallback(
  req: LlmRequest,
  tier: TierConfig,
  messages: LlmMessage[],
  temperature: number,
  timeoutMs: number,
): Promise<{ completion: ProviderCompletion; outcome: CallOutcome }> {
  const list = targets(tier);
  let lastErr: unknown;
  let lastProvider = tier.provider;
  for (let i = 0; i < list.length; i++) {
    const target = list[i]!;
    lastProvider = target.provider;
    const started = Date.now();
    try {
      const provider = getLlmProvider(target.provider);
      const completion = await withTimeout(timeoutMs, undefined, (signal) =>
        provider.complete(providerCall(target, req, messages, temperature, signal)),
      );
      const inputTokens = completion.inputTokens || estimateTokens(req.system + messages.map((m) => m.content).join(''));
      const outputTokens = completion.outputTokens || estimateTokens(completion.text);
      recordLlmCost(req, target, inputTokens, outputTokens);
      return {
        completion: { ...completion, inputTokens, outputTokens },
        outcome: { provider: target.provider, latencyMs: Date.now() - started, fellBack: i > 0 },
      };
    } catch (e) {
      lastErr = e;
      if (!isFallbackEligible(e) || i === list.length - 1) break;
      log.warn(
        { purpose: req.purpose, tier: req.tier, provider: target.provider, fallback: list[i + 1]!.provider, err: e instanceof Error ? e.message : String(e) },
        'llm primary failed; retrying on fallback provider',
      );
    }
  }
  throw mapProviderError(lastErr, req.purpose, lastProvider);
}

function repairMessages(messages: LlmMessage[], badText: string, error: string): LlmMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: badText.length > 0 ? badText : '(empty response)' },
    {
      role: 'user',
      content:
        `Your previous response was invalid: ${error}\n` +
        'Reply again with only a single JSON value that validates against the JSON Schema. No prose, no code fences.',
    },
  ];
}

function resolveTier(req: LlmRequest): { tier: TierConfig; temperature: number; timeoutMs: number } {
  const tier = getLlmConfig().tiers[req.tier];
  return {
    tier,
    temperature: req.temperature ?? tier.defaultTemperature,
    timeoutMs: req.timeoutMs ?? tier.timeoutMs,
  };
}

// ---------------------------------------------------------------------------------------
// complete()
// ---------------------------------------------------------------------------------------

export async function complete(req: LlmRequest): Promise<LlmResult> {
  validateRequest(req);
  const { tier, temperature, timeoutMs } = resolveTier(req);
  const key = req.cacheable
    ? llmCacheKey({ tier: req.tier, model: tier.model, system: req.system, messages: req.messages, temperature, ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}) })
    : undefined;

  if (key) {
    const hit = await cacheGet(key);
    if (hit) {
      logCall(req, hit, undefined);
      return hit;
    }
  }

  return withSpan(
    'llm.complete',
    async () => {
      let { completion, outcome } = await completeWithFallback(req, tier, req.messages, temperature, timeoutMs);
      let inputTokens = completion.inputTokens;
      let outputTokens = completion.outputTokens;
      let json: unknown;
      let repaired = false;

      if (req.jsonSchema) {
        let check = parseAndValidate(completion.text, req.jsonSchema);
        if (!check.ok) {
          log.warn({ purpose: req.purpose, tier: req.tier, error: check.error.slice(0, 300) }, 'llm output failed schema; retrying once');
          const retryMessages = repairMessages(req.messages, completion.text, check.error);
          ({ completion, outcome } = await completeWithFallback(req, tier, retryMessages, temperature, timeoutMs));
          inputTokens += completion.inputTokens;
          outputTokens += completion.outputTokens;
          repaired = true;
          check = parseAndValidate(completion.text, req.jsonSchema);
          if (!check.ok) {
            logCall(req, { text: completion.text, model: completion.model, inputTokens, outputTokens, cached: false }, outcome, {
              badOutput: true,
            });
            throw new LlmBadOutputError(req.purpose, check.error);
          }
        }
        json = check.value;
      }

      const result: LlmResult = {
        text: completion.text,
        ...(req.jsonSchema ? { json } : {}),
        model: completion.model,
        inputTokens,
        outputTokens,
        cached: false,
      };
      if (key) await cachePut(key, result, getLlmConfig().cacheTtlSec);
      logCall(req, result, outcome, repaired ? { repaired } : {});
      return result;
    },
    { 'llm.tier': req.tier, 'llm.purpose': req.purpose },
  );
}

// ---------------------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------------------

/** Minimal single-consumer async queue used to decouple the producer from the iterator. */
class ChunkQueue {
  private items: LlmStreamChunk[] = [];
  private waiters: Array<{ resolve: (r: IteratorResult<LlmStreamChunk>) => void; reject: (e: unknown) => void }> = [];
  private done = false;
  private error: unknown;
  private failed = false;

  push(c: LlmStreamChunk): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: c, done: false });
    else this.items.push(c);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  fail(e: unknown): void {
    if (this.done) return;
    this.done = true;
    this.failed = true;
    this.error = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  next(): Promise<IteratorResult<LlmStreamChunk>> {
    const c = this.items.shift();
    if (c) return Promise.resolve({ value: c, done: false });
    if (this.done) {
      if (this.failed) return Promise.reject(this.error);
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  close(): void {
    this.items = [];
    this.end();
  }
}

/**
 * Streams text deltas. Validation/PII errors throw synchronously. The upstream call starts
 * immediately; `final` resolves with the full result (or rejects) even if nobody iterates.
 * Breaking out of the iteration aborts the upstream request.
 *
 * Fallback applies only if the primary fails before emitting any text. A `jsonSchema` stream
 * cannot be retried after text has been emitted, so an invalid final JSON rejects `final`
 * with LLM_BAD_OUTPUT without a repair attempt.
 */
export function stream(req: LlmRequest): LlmStream {
  validateRequest(req);
  const { tier, temperature, timeoutMs } = resolveTier(req);
  const queue = new ChunkQueue();
  const consumerAbort = new AbortController();
  let resolveFinal!: (r: LlmResult) => void;
  let rejectFinal!: (e: unknown) => void;
  const final = new Promise<LlmResult>((res, rej) => {
    resolveFinal = res;
    rejectFinal = rej;
  });
  // Mark handled so a consumer that only iterates does not trigger an unhandled rejection.
  final.catch(() => undefined);

  const key = req.cacheable
    ? llmCacheKey({ tier: req.tier, model: tier.model, system: req.system, messages: req.messages, temperature, ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}) })
    : undefined;

  const produce = async (): Promise<LlmResult> => {
    if (key) {
      const hit = await cacheGet(key);
      if (hit) {
        if (hit.text.length > 0) queue.push({ delta: hit.text });
        logCall(req, hit, undefined, { streamed: true });
        return hit;
      }
    }
    return withSpan(
      'llm.stream',
      async () => {
        const list = targets(tier);
        let lastErr: unknown;
        for (let i = 0; i < list.length; i++) {
          const target = list[i]!;
          const started = Date.now();
          let text = '';
          let emitted = false;
          let inTok: number | undefined;
          let outTok: number | undefined;
          let model = target.model;
          try {
            const provider = getLlmProvider(target.provider);
            await withTimeout(timeoutMs, consumerAbort.signal, async (signal) => {
              for await (const ev of provider.stream(providerCall(target, req, req.messages, temperature, signal))) {
                if (consumerAbort.signal.aborted) break;
                if (ev.type === 'delta') {
                  text += ev.text;
                  emitted = true;
                  queue.push({ delta: ev.text });
                } else {
                  if (ev.inputTokens !== undefined) inTok = ev.inputTokens;
                  if (ev.outputTokens !== undefined) outTok = ev.outputTokens;
                  if (ev.model) model = ev.model;
                }
              }
            });
          } catch (e) {
            if (consumerAbort.signal.aborted) {
              // Consumer stopped early: still bill what was consumed, then settle.
              const inputTokens = inTok ?? estimateTokens(req.system + req.messages.map((m) => m.content).join(''));
              recordLlmCost(req, target, inputTokens, outTok ?? estimateTokens(text));
              throw new AppError('INTERNAL', 'LLM stream was cancelled by the consumer', { purpose: req.purpose });
            }
            lastErr = e;
            if (emitted || !isFallbackEligible(e) || i === list.length - 1) {
              if (emitted) {
                const inputTokens = inTok ?? estimateTokens(req.system + req.messages.map((m) => m.content).join(''));
                recordLlmCost(req, target, inputTokens, outTok ?? estimateTokens(text));
              }
              throw mapProviderError(e, req.purpose, target.provider);
            }
            log.warn(
              { purpose: req.purpose, tier: req.tier, provider: target.provider, fallback: list[i + 1]!.provider, err: e instanceof Error ? e.message : String(e) },
              'llm stream primary failed before output; retrying on fallback provider',
            );
            continue;
          }

          const inputTokens = inTok ?? estimateTokens(req.system + req.messages.map((m) => m.content).join(''));
          const outputTokens = outTok ?? estimateTokens(text);
          recordLlmCost(req, target, inputTokens, outputTokens);
          const outcome: CallOutcome = { provider: target.provider, latencyMs: Date.now() - started, fellBack: i > 0 };

          if (consumerAbort.signal.aborted) {
            throw new AppError('INTERNAL', 'LLM stream was cancelled by the consumer', { purpose: req.purpose });
          }

          let json: unknown;
          if (req.jsonSchema) {
            const check = parseAndValidate(text, req.jsonSchema);
            if (!check.ok) {
              logCall(req, { text, model, inputTokens, outputTokens, cached: false }, outcome, { streamed: true, badOutput: true });
              throw new LlmBadOutputError(req.purpose, check.error);
            }
            json = check.value;
          }
          const result: LlmResult = { text, ...(req.jsonSchema ? { json } : {}), model, inputTokens, outputTokens, cached: false };
          if (key) await cachePut(key, result, getLlmConfig().cacheTtlSec);
          logCall(req, result, outcome, { streamed: true });
          return result;
        }
        throw mapProviderError(lastErr, req.purpose, list[list.length - 1]!.provider);
      },
      { 'llm.tier': req.tier, 'llm.purpose': req.purpose },
    );
  };

  produce().then(
    (r) => {
      queue.end();
      resolveFinal(r);
    },
    (e: unknown) => {
      queue.fail(e);
      rejectFinal(e);
    },
  );

  const iterator: AsyncIterator<LlmStreamChunk> = {
    next: () => queue.next(),
    return: (): Promise<IteratorResult<LlmStreamChunk>> => {
      consumerAbort.abort();
      queue.close();
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  return {
    [Symbol.asyncIterator]: () => iterator,
    final,
  };
}

// ---------------------------------------------------------------------------------------
// embed()  (LLD extension: tier `embed`, batch size 128)
// ---------------------------------------------------------------------------------------

export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) {
    throw new AppError('VALIDATION', 'embed(texts) requires an array of strings');
  }
  const purpose = opts.purpose ?? 'embed';
  const piiFree = opts.piiFree ?? true;
  if (piiFree) assertNoPii(purpose, texts);
  if (texts.length === 0) return [];

  const cfg = getLlmConfig();
  const tier = cfg.tiers.embed;
  const timeoutMs = opts.timeoutMs ?? tier.timeoutMs;
  const out: number[][] = [];
  const costReq = { purpose, ...(opts.ctx ? { ctx: opts.ctx } : {}) };

  return withSpan(
    'llm.embed',
    async () => {
      let totalTokens = 0;
      for (let start = 0; start < texts.length; start += cfg.embedBatchSize) {
        // Providers reject empty strings; embed a single space instead so indices stay aligned.
        const batch = texts.slice(start, start + cfg.embedBatchSize).map((t) => (t.length === 0 ? ' ' : t));
        const list = targets(tier);
        let lastErr: unknown;
        let done = false;
        for (let i = 0; i < list.length && !done; i++) {
          const target = list[i]!;
          try {
            const provider = getLlmProvider(target.provider);
            if (!provider.embed) throw new AppError('INTERNAL', `LLM provider "${target.provider}" does not support embeddings`);
            const embedFn = provider.embed.bind(provider);
            const res = await withTimeout(timeoutMs, undefined, (signal) =>
              embedFn({
                model: target.model,
                texts: batch,
                ...(tier.dimensions !== undefined ? { dimensions: tier.dimensions } : {}),
                ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
                signal,
              }),
            );
            const tokens = res.inputTokens || batch.reduce((n, t) => n + estimateTokens(t), 0);
            recordLlmCost(costReq, target, tokens, 0);
            if (res.vectors.length !== batch.length) {
              throw new LlmBadOutputError(purpose, `expected ${batch.length} vectors, got ${res.vectors.length}`);
            }
            for (const v of res.vectors) {
              if (tier.dimensions !== undefined && v.length !== tier.dimensions) {
                throw new LlmBadOutputError(purpose, `expected ${tier.dimensions}-dimensional vectors, got ${v.length}`);
              }
              out.push(v);
            }
            totalTokens += tokens;
            done = true;
          } catch (e) {
            lastErr = e;
            if (!isFallbackEligible(e) || i === list.length - 1) throw mapProviderError(e, purpose, target.provider);
            log.warn({ purpose, provider: target.provider, err: e instanceof Error ? e.message : String(e) }, 'embed primary failed; retrying on fallback');
          }
        }
        if (!done) throw mapProviderError(lastErr, purpose, tier.provider);
      }
      log.info({ llm: { purpose, tier: 'embed', model: tier.model, texts: texts.length, inputTokens: totalTokens } }, 'llm embed');
      return out;
    },
    { 'llm.tier': 'embed', 'llm.purpose': purpose },
  );
}
