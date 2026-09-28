/**
 * M29 tests (no network, no database): slot staleness/merge logic, the reverify RPC client's
 * fail-safe degradation, and the bounded-concurrency helper used by bulk reveal.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { ActorContext, Entitlements } from '../m01_platform/index.js';
import { mapLimit } from './concurrency.js';
import { configureReverifyClient, resetReverifyClientForTesting, reverify, type ReverifyTransport } from './reverify.js';
import { excludeInvalid, isStale, resolveSlots, splitByStaleness } from './slots.js';
import type { ProfileContactSlot } from './types.js';

const ENT: Entitlements = {
  plan: 'free',
  searchResultCap: 20,
  exportRowsPerMonth: 0,
  bulkRevealMax: 50,
  checksPerMonth: 0,
  revealsIncludedPerMonth: 3,
};

const CTX: ActorContext = {
  kind: 'user',
  entitlements: ENT,
  locale: 'en',
  region: 'IN',
  mfaVerified: true,
  correlationId: 'corr-m29-test',
};

const NOW = new Date('2026-09-28T00:00:00.000Z');

function slot(over: Partial<ProfileContactSlot> = {}): ProfileContactSlot {
  return {
    assertion_id: '11111111-1111-7111-8111-111111111111',
    kind: 'phone',
    source_type: 'web.crawl',
    checked_at: NOW.toISOString(),
    deliverability: 'valid',
    ...over,
  };
}

describe('m29 slots', () => {
  test('isStale: fresh checked_at is not stale; missing/old is', () => {
    assert.equal(isStale(NOW.toISOString(), NOW), false);
    assert.equal(isStale(null, NOW), true);
    const old = new Date(NOW.getTime() - 91 * 24 * 3600 * 1000).toISOString();
    assert.equal(isStale(old, NOW), true);
    const recent = new Date(NOW.getTime() - 89 * 24 * 3600 * 1000).toISOString();
    assert.equal(isStale(recent, NOW), false);
  });

  test('splitByStaleness partitions slots correctly', () => {
    const fresh = slot({ assertion_id: 'a', checked_at: NOW.toISOString() });
    const old = slot({ assertion_id: 'b', checked_at: new Date(NOW.getTime() - 200 * 24 * 3600 * 1000).toISOString() });
    const missing = slot({ assertion_id: 'c', checked_at: null });
    const { fresh: freshOut, stale } = splitByStaleness([fresh, old, missing], NOW);
    assert.deepEqual(freshOut.map((s) => s.assertion_id), ['a']);
    assert.deepEqual(stale.map((s) => s.assertion_id).sort(), ['b', 'c']);
  });

  test('resolveSlots: fresh slot keeps its own deliverability, stale:false', () => {
    const s = slot({ assertion_id: 'a', deliverability: 'valid', checked_at: NOW.toISOString() });
    const [r] = resolveSlots([s], new Map(), NOW);
    assert.equal(r!.deliverability, 'valid');
    assert.equal(r!.stale, false);
  });

  test('resolveSlots: stale slot with a valid/risky outcome is fresh, not stale', () => {
    const s = slot({ assertion_id: 'a', checked_at: null });
    const outcomes = new Map([['a', { assertionId: 'a', status: 'risky' as const, checkedAt: NOW }]]);
    const [r] = resolveSlots([s], outcomes, NOW);
    assert.equal(r!.deliverability, 'risky');
    assert.equal(r!.stale, false);
  });

  test('resolveSlots: stale slot with an unknown outcome is included with stale:true (LLD M29 step 5)', () => {
    const s = slot({ assertion_id: 'a', checked_at: null });
    const outcomes = new Map([['a', { assertionId: 'a', status: 'unknown' as const, checkedAt: NOW }]]);
    const [r] = resolveSlots([s], outcomes, NOW);
    assert.equal(r!.deliverability, 'unknown');
    assert.equal(r!.stale, true);
  });

  test('resolveSlots: a stale slot with no matching outcome fails safe to unknown/stale', () => {
    const s = slot({ assertion_id: 'missing-outcome', checked_at: null });
    const [r] = resolveSlots([s], new Map(), NOW);
    assert.equal(r!.deliverability, 'unknown');
    assert.equal(r!.stale, true);
  });

  test('excludeInvalid drops invalid slots and keeps the rest', () => {
    const rows = resolveSlots(
      [slot({ assertion_id: 'a', deliverability: 'invalid' }), slot({ assertion_id: 'b', deliverability: 'valid' })],
      new Map(),
      NOW,
    );
    const out = excludeInvalid(rows);
    assert.deepEqual(out.map((r) => r.assertionId), ['b']);
  });
});

function transport(status: number, body: unknown, seen?: { url?: string; body?: string }): ReverifyTransport {
  return async (url, init) => {
    if (seen) {
      seen.url = url;
      seen.body = init.body;
    }
    return { status, json: async () => body };
  };
}

function use(t: ReverifyTransport, timeoutMs = 500): void {
  configureReverifyClient({ baseUrl: 'http://kp.test', token: () => 'tok', timeoutMs, transport: t });
}

describe('m29 reverify client', () => {
  afterEach(() => resetReverifyClientForTesting());

  test('empty input short-circuits without a call', async () => {
    let called = false;
    use(async () => {
      called = true;
      return { status: 200, json: async () => ({ outcomes: [] }) };
    });
    const out = await reverify(CTX, [], 'reveal', 'r1');
    assert.deepEqual(out, []);
    assert.equal(called, false);
  });

  test('maps a 200 response to VerifyOutcome[], preserving request order', async () => {
    const seen: { url?: string; body?: string } = {};
    use(
      transport(200, {
        outcomes: [
          { assertionId: 'b', status: 'invalid', checkedAt: '2026-09-01T00:00:00Z' },
          { assertionId: 'a', status: 'valid', checkedAt: '2026-09-02T00:00:00Z' },
        ],
      }, seen),
    );
    const out = await reverify(CTX, ['a', 'b'], 'reveal', 'trigger-ref');
    assert.equal(out.length, 2);
    assert.equal(out[0]!.assertionId, 'a');
    assert.equal(out[0]!.status, 'valid');
    assert.equal(out[1]!.assertionId, 'b');
    assert.equal(out[1]!.status, 'invalid');
    assert.equal(seen.url, 'http://kp.test/rpc/reverify');
    const sentBody = JSON.parse(seen.body!) as { assertionIds: string[]; trigger: string; triggerRef: string };
    assert.deepEqual(sentBody.assertionIds, ['a', 'b']);
    assert.equal(sentBody.trigger, 'reveal');
    assert.equal(sentBody.triggerRef, 'trigger-ref');
  });

  test('a missing id in the response defaults to unknown', async () => {
    use(transport(200, { outcomes: [{ assertionId: 'a', status: 'valid', checkedAt: '2026-09-02T00:00:00Z' }] }));
    const out = await reverify(CTX, ['a', 'b'], 'reveal', 'r1');
    const byId = new Map(out.map((o) => [o.assertionId, o]));
    assert.equal(byId.get('a')!.status, 'valid');
    assert.equal(byId.get('b')!.status, 'unknown');
  });

  test('a transport failure degrades to unknown for every requested id, not a thrown error', async () => {
    use(async () => {
      throw new Error('ECONNREFUSED');
    });
    const out = await reverify(CTX, ['a', 'b', 'c'], 'reveal', 'r1');
    assert.equal(out.length, 3);
    for (const o of out) assert.equal(o.status, 'unknown');
  });

  test('a non-200 status degrades to unknown', async () => {
    use(transport(500, { error: { code: 'INTERNAL' } }));
    const out = await reverify(CTX, ['a'], 'reveal', 'r1');
    assert.equal(out[0]!.status, 'unknown');
  });

  test('a malformed response body degrades to unknown', async () => {
    use(transport(200, { nope: true }));
    const out = await reverify(CTX, ['a'], 'reveal', 'r1');
    assert.equal(out[0]!.status, 'unknown');
  });

  test('more than 500 ids is rejected before any call is made', async () => {
    let called = false;
    use(async () => {
      called = true;
      return { status: 200, json: async () => ({ outcomes: [] }) };
    });
    const many = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await assert.rejects(reverify(CTX, many, 'reveal', 'r1'), /At most 500/);
    assert.equal(called, false);
  });
});

describe('m29 concurrency', () => {
  test('mapLimit preserves result order and honours the concurrency bound', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [50, 10, 30, 5, 20, 15, 1, 40];
    const out = await mapLimit(items, 3, async (ms) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return ms * 2;
    });
    assert.deepEqual(out, items.map((v) => v * 2));
    assert.ok(maxInFlight <= 3, `expected at most 3 in flight, got ${maxInFlight}`);
  });

  test('mapLimit with an empty list resolves to an empty array', async () => {
    const out = await mapLimit<number, number>([], 4, async (n) => n);
    assert.deepEqual(out, []);
  });
});
