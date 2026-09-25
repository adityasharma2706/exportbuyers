/**
 * M03 — provider implementations behind the provider-agnostic adapter.
 *
 *   anthropic : Messages API (complete + SSE stream)
 *   openai    : Chat Completions API (complete + SSE stream + embeddings); any OpenAI-compatible endpoint via baseUrl
 *   voyage    : embeddings (OpenAI-shaped /v1/embeddings)
 *
 * API keys come from the secrets manager as `<PROVIDER>_API_KEY` (e.g. ANTHROPIC_API_KEY).
 * Custom providers (and test fakes) can be added with registerLlmProvider().
 */
import { AppError, getSecret } from '../m01_platform/index.js';
import type { LlmMessage } from './types.js';

export interface ProviderCall {
  model: string;
  maxTokens: number;
  system: string;
  messages: LlmMessage[];
  temperature: number;
  jsonSchema?: object;
  baseUrl?: string;
  signal: AbortSignal;
}

export interface ProviderCompletion {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type ProviderStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; model?: string };

export interface ProviderEmbedCall {
  model: string;
  texts: string[];
  dimensions?: number;
  baseUrl?: string;
  signal: AbortSignal;
}

export interface ProviderEmbedding {
  vectors: number[][];
  model: string;
  inputTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(call: ProviderCall): Promise<ProviderCompletion>;
  stream(call: ProviderCall): AsyncIterable<ProviderStreamEvent>;
  embed?(call: ProviderEmbedCall): Promise<ProviderEmbedding>;
}

/** An HTTP-level failure from a provider. `status` 0 means a network error (no response). */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly provider: string;
  constructor(provider: string, status: number, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ProviderHttpError';
    this.provider = provider;
    this.status = status;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Instruction appended to the system prompt for providers without native schema-constrained output. */
export function jsonInstruction(schema: object): string {
  return (
    '\n\nRespond with only a single JSON value that validates against the following JSON Schema. ' +
    'Do not include prose, explanations or code fences.\nJSON Schema:\n' +
    JSON.stringify(schema)
  );
}

function apiKey(provider: string): string {
  return getSecret(`${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function postJson(provider: string, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ProviderHttpError(provider, 0, `${provider}: network error`, { cause: e });
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      detail = '';
    }
    throw new ProviderHttpError(provider, res.status, `${provider}: HTTP ${res.status} ${detail}`);
  }
  return res;
}

/** Parses a text/event-stream body into {event, data} records. */
export async function* parseSse(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const rec = parseSseRecord(raw);
        if (rec) yield rec;
      }
    }
    buf += decoder.decode();
    const rec = parseSseRecord(buf);
    if (rec) yield rec;
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // reader may already be released after cancel
    }
  }
}

function parseSseRecord(raw: string): { event: string; data: string } | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':') || line.length === 0) continue;
    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let val = colon >= 0 ? line.slice(colon + 1) : '';
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'event') event = val;
    else if (field === 'data') data.push(val);
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join('\n') };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------

const ANTHROPIC_BASE = 'https://api.anthropic.com';

function anthropicBody(call: ProviderCall, stream: boolean): Record<string, unknown> {
  const system = call.jsonSchema ? call.system + jsonInstruction(call.jsonSchema) : call.system;
  return {
    model: call.model,
    max_tokens: call.maxTokens,
    ...(system.length > 0 ? { system } : {}),
    messages: call.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: Math.min(1, call.temperature),
    ...(stream ? { stream: true } : {}),
  };
}

function anthropicHeaders(): Record<string, string> {
  return { 'x-api-key': apiKey('anthropic'), 'anthropic-version': '2023-06-01' };
}

export const anthropicProvider: LlmProvider = {
  name: 'anthropic',
  async complete(call) {
    const res = await postJson('anthropic', joinUrl(call.baseUrl ?? ANTHROPIC_BASE, '/v1/messages'), anthropicHeaders(), anthropicBody(call, false), call.signal);
    const j = (await res.json()) as {
      model?: string;
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (j.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('');
    return {
      text,
      model: j.model ?? call.model,
      inputTokens: num(j.usage?.input_tokens) ?? 0,
      outputTokens: num(j.usage?.output_tokens) ?? 0,
    };
  },
  async *stream(call) {
    const res = await postJson('anthropic', joinUrl(call.baseUrl ?? ANTHROPIC_BASE, '/v1/messages'), anthropicHeaders(), anthropicBody(call, true), call.signal);
    for await (const rec of parseSse(res.body, call.signal)) {
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(rec.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = (j.type as string | undefined) ?? rec.event;
      if (type === 'message_start') {
        const msg = j.message as { model?: string; usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
        yield { type: 'usage', inputTokens: num(msg?.usage?.input_tokens), outputTokens: num(msg?.usage?.output_tokens), model: msg?.model };
      } else if (type === 'content_block_delta') {
        const d = j.delta as { type?: string; text?: string } | undefined;
        if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text.length > 0) yield { type: 'delta', text: d.text };
      } else if (type === 'message_delta') {
        const u = j.usage as { output_tokens?: number; input_tokens?: number } | undefined;
        yield { type: 'usage', outputTokens: num(u?.output_tokens), inputTokens: num(u?.input_tokens) };
      } else if (type === 'error') {
        const err = j.error as { type?: string; message?: string } | undefined;
        // Mid-stream errors (e.g. overloaded_error) are server-side; surface as a 5xx-class failure.
        throw new ProviderHttpError('anthropic', err?.type === 'invalid_request_error' ? 400 : 529, `anthropic stream error: ${err?.type ?? 'unknown'}`);
      } else if (type === 'message_stop') {
        return;
      }
    }
  },
};

// ---------------------------------------------------------------------------------------
// OpenAI (and OpenAI-compatible)
// ---------------------------------------------------------------------------------------

const OPENAI_BASE = 'https://api.openai.com';

function openaiBody(call: ProviderCall, stream: boolean): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];
  if (call.system.length > 0) messages.push({ role: 'system', content: call.system });
  for (const m of call.messages) messages.push({ role: m.role, content: m.content });
  return {
    model: call.model,
    max_tokens: call.maxTokens,
    messages,
    temperature: call.temperature,
    ...(call.jsonSchema
      ? { response_format: { type: 'json_schema', json_schema: { name: 'output', schema: call.jsonSchema, strict: false } } }
      : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

function bearer(provider: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey(provider)}` };
}

async function openAiStyleEmbed(provider: string, defaultBase: string, dimsField: string, call: ProviderEmbedCall): Promise<ProviderEmbedding> {
  const body: Record<string, unknown> = { model: call.model, input: call.texts };
  if (call.dimensions !== undefined) body[dimsField] = call.dimensions;
  const res = await postJson(provider, joinUrl(call.baseUrl ?? defaultBase, '/v1/embeddings'), bearer(provider), body, call.signal);
  const j = (await res.json()) as {
    model?: string;
    data?: Array<{ embedding?: unknown; index?: number }>;
    usage?: { total_tokens?: number; prompt_tokens?: number };
  };
  const data = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = data.map((d) => {
    if (!Array.isArray(d.embedding) || !d.embedding.every((x) => typeof x === 'number')) {
      throw new ProviderHttpError(provider, 502, `${provider}: embedding response is malformed`);
    }
    return d.embedding as number[];
  });
  return {
    vectors,
    model: j.model ?? call.model,
    inputTokens: num(j.usage?.total_tokens) ?? num(j.usage?.prompt_tokens) ?? 0,
  };
}

export const openaiProvider: LlmProvider = {
  name: 'openai',
  async complete(call) {
    const res = await postJson('openai', joinUrl(call.baseUrl ?? OPENAI_BASE, '/v1/chat/completions'), bearer('openai'), openaiBody(call, false), call.signal);
    const j = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: j.choices?.[0]?.message?.content ?? '',
      model: j.model ?? call.model,
      inputTokens: num(j.usage?.prompt_tokens) ?? 0,
      outputTokens: num(j.usage?.completion_tokens) ?? 0,
    };
  },
  async *stream(call) {
    const res = await postJson('openai', joinUrl(call.baseUrl ?? OPENAI_BASE, '/v1/chat/completions'), bearer('openai'), openaiBody(call, true), call.signal);
    for await (const rec of parseSse(res.body, call.signal)) {
      if (rec.data === '[DONE]') return;
      let j: {
        model?: string;
        choices?: Array<{ delta?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        error?: { message?: string };
      };
      try {
        j = JSON.parse(rec.data) as typeof j;
      } catch {
        continue;
      }
      if (j.error) throw new ProviderHttpError('openai', 500, `openai stream error: ${j.error.message ?? 'unknown'}`);
      const text = j.choices?.[0]?.delta?.content;
      if (typeof text === 'string' && text.length > 0) yield { type: 'delta', text };
      if (j.usage) {
        yield { type: 'usage', inputTokens: num(j.usage.prompt_tokens), outputTokens: num(j.usage.completion_tokens), model: j.model };
      }
    }
  },
  embed(call) {
    return openAiStyleEmbed('openai', OPENAI_BASE, 'dimensions', call);
  },
};

// ---------------------------------------------------------------------------------------
// Voyage (embeddings only)
// ---------------------------------------------------------------------------------------

function embedOnly(name: string): never {
  throw new AppError('INTERNAL', `LLM provider "${name}" supports embeddings only; configure a text tier with another provider`);
}

export const voyageProvider: LlmProvider = {
  name: 'voyage',
  async complete(): Promise<ProviderCompletion> {
    return embedOnly('voyage');
  },
  stream(): AsyncIterable<ProviderStreamEvent> {
    return embedOnly('voyage');
  },
  embed(call) {
    return openAiStyleEmbed('voyage', 'https://api.voyageai.com', 'output_dimension', call);
  },
};

// ---------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------

const registry = new Map<string, LlmProvider>([
  [anthropicProvider.name, anthropicProvider],
  [openaiProvider.name, openaiProvider],
  [voyageProvider.name, voyageProvider],
]);

/** Adds or replaces a provider (e.g. an in-region gateway, or a fake in tests). */
export function registerLlmProvider(p: LlmProvider): void {
  registry.set(p.name, p);
}

export function unregisterLlmProvider(name: string): void {
  registry.delete(name);
}

export function getLlmProvider(name: string): LlmProvider {
  const p = registry.get(name);
  if (!p) throw new AppError('INTERNAL', `LLM provider "${name}" is not registered`);
  return p;
}
