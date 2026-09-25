/**
 * M03 tests: caching, structured-output repair, fallback, PII guard, streaming, embeddings.
 * Uses in-memory fake providers and a fake Redis; no network.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppError, pendingCostEvents } from '../m01_platform/index.js';
import type { RedisLike } from '../m01_platform/index.js';
import {
  DEFAULT_LLM_CONFIG,
  LlmBadOutputError,
  ProviderHttpError,
  buildLlmConfig,
  complete,
  detectPii,
  embed,
  registerLlmProvider,
  setLlmCacheClientForTesting,
  setLlmConfigForTesting,
  stream,
  unregisterLlmProvider,
  validateJson,
} from './index.js';
import type { LlmProvider, LlmRequest, ProviderCall, ProviderStreamEvent } from './index.js';

class FakeRedis implements RedisLike {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return 'OK';
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
  async quit(): Promise<unknown> {
    return 'OK';
  }
}

function fakeProvider(name: string, replies: Array<string | Error>): LlmProvider & { calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  const next = (): string => {
    const r = replies.shift();
    if (r === undefined) throw new Error(`${name}: no more replies`);
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    name,
    calls,
    async complete(call) {
      calls.push(call);
      const text = next();
      return { text, model: call.model, inputTokens: 10, outputTokens: 5 };
    },
    async *stream(call): AsyncIterable<ProviderStreamEvent> {
      calls.push(call);
      const text = next();
      yield { type: 'usage', inputTokens: 10, model: call.model };
      for (const part of text.match(/.{1,3}/gs) ?? []) yield { type: 'delta', text: part };
      yield { type: 'usage', outputTokens: 5 };
    },
    async embed(call) {
      return { vectors: call.texts.map(() => new Array<number>(4).fill(0.5)), model: call.model, inputTokens: call.texts.length };
    },
  };
}

function config(withFallback: boolean) {
  return buildLlmConfig({
    tiers: {
      classify: { provider: 'fake-a', model: 'small', ...(withFallback ? { fallback: { ...DEFAULT_LLM_CONFIG.tiers.classify, provider: 'fake-b', model: 'small-b' } } : {}) },
      draft: { provider: 'fake-a', model: 'big' },
      embed: { provider: 'fake-a', model: 'emb', dimensions: 4 },
    },
    embedBatchSize: 2,
  });
}

const baseReq: LlmRequest = {
  tier: 'classify',
  purpose: 'test.classify',
  system: 'Classify the page.',
  messages: [{ role: 'user', content: 'Acme Textiles imports cotton yarn under HS 5205.' }],
  piiFree: true,
};

describe('M03 LLM adapter', () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
    setLlmCacheClientForTesting(redis);
    setLlmConfigForTesting(config(false));
  });
  afterEach(() => {
    unregisterLlmProvider('fake-a');
    unregisterLlmProvider('fake-b');
    setLlmCacheClientForTesting(undefined);
    setLlmConfigForTesting(undefined);
  });

  it('caches cacheable requests and records cost only for provider calls', async () => {
    const a = fakeProvider('fake-a', ['importer']);
    registerLlmProvider(a);
    const before = pendingCostEvents();
    const r1 = await complete({ ...baseReq, cacheable: true });
    const r2 = await complete({ ...baseReq, cacheable: true });
    assert.equal(r1.cached, false);
    assert.equal(r2.cached, true);
    assert.equal(r2.text, 'importer');
    assert.equal(a.calls.length, 1);
    assert.equal(pendingCostEvents() - before, 1);
  });

  it('retries once with the validation error and then throws LLM_BAD_OUTPUT', async () => {
    const schema = { type: 'object', required: ['label'], properties: { label: { enum: ['importer', 'other'] } } };
    const a = fakeProvider('fake-a', ['not json', '{"label":"importer"}']);
    registerLlmProvider(a);
    const ok = await complete({ ...baseReq, jsonSchema: schema });
    assert.deepEqual(ok.json, { label: 'importer' });
    assert.equal(a.calls.length, 2);
    assert.equal(a.calls[1]!.messages.length, 3);

    registerLlmProvider(fakeProvider('fake-a', ['{"label":"x"}', '{"label":"y"}']));
    await assert.rejects(complete({ ...baseReq, jsonSchema: schema }), (e: unknown) => e instanceof LlmBadOutputError && e.code === 'INTERNAL');
  });

  it('falls back once on 5xx, else UPSTREAM_UNAVAILABLE', async () => {
    setLlmConfigForTesting(config(true));
    registerLlmProvider(fakeProvider('fake-a', [new ProviderHttpError('fake-a', 503, 'down')]));
    const b = fakeProvider('fake-b', ['other']);
    registerLlmProvider(b);
    const r = await complete(baseReq);
    assert.equal(r.text, 'other');
    assert.equal(b.calls.length, 1);

    registerLlmProvider(fakeProvider('fake-a', [new ProviderHttpError('fake-a', 500, 'down')]));
    registerLlmProvider(fakeProvider('fake-b', [new ProviderHttpError('fake-b', 502, 'down')]));
    await assert.rejects(complete(baseReq), (e: unknown) => e instanceof AppError && e.code === 'UPSTREAM_UNAVAILABLE');
  });

  it('rejects piiFree prompts with email or phone patterns', async () => {
    registerLlmProvider(fakeProvider('fake-a', ['x']));
    await assert.rejects(
      complete({ ...baseReq, messages: [{ role: 'user', content: 'mail ravi@example.com' }] }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION',
    );
    assert.deepEqual(detectPii('call +91 98765 43210'), ['phone']);
    assert.deepEqual(detectPii('HS 9403.60.1000 and 8517.62'), []);
    // piiFree:false requests are allowed through (they are just not logged).
    const r = await complete({ ...baseReq, piiFree: false, messages: [{ role: 'user', content: 'mail ravi@example.com' }] });
    assert.equal(r.text, 'x');
  });

  it('streams deltas and resolves final', async () => {
    registerLlmProvider(fakeProvider('fake-a', ['hello world']));
    const s = stream({ ...baseReq, tier: 'draft', piiFree: false });
    let text = '';
    for await (const c of s) text += c.delta;
    const final = await s.final;
    assert.equal(text, 'hello world');
    assert.equal(final.text, 'hello world');
    assert.equal(final.inputTokens, 10);
    assert.equal(final.outputTokens, 5);
  });

  it('embeds in batches and checks dimensions', async () => {
    registerLlmProvider(fakeProvider('fake-a', []));
    const v = await embed(['a', 'b', 'c']);
    assert.equal(v.length, 3);
    assert.equal(v[0]!.length, 4);
  });

  it('validates JSON schema subsets', () => {
    const schema = { type: 'object', additionalProperties: false, properties: { n: { type: 'integer', minimum: 1 } }, required: ['n'] };
    assert.deepEqual(validateJson({ n: 2 }, schema), []);
    assert.equal(validateJson({ n: 0 }, schema).length, 1);
    assert.equal(validateJson({ n: 1, x: 1 }, schema).length, 1);
  });
});
