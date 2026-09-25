/**
 * M04 unit tests: price display, navigation, catalogue integrity, trust wording, budgets and the
 * literal-text check. Only framework-free modules are imported so the suite runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeCost,
  createPriceClient,
  parseCatalogue,
  PriceUnavailableError,
  resolveCost,
  type FetchLike,
  type PriceCatalogueDto,
} from './pricing/prices.js';
import { activeNavId, isNavItemActive, NAV_ITEMS, partitionNav } from './nav.js';
import { diffCatalogues, flattenMessages, getMessage, pickMessages, argumentsOf, type Messages } from './i18n/messages.js';
import { containsForbiddenTrustWording, guardTrustText, orderTrustChecks, splitCoverageKey, trustCounts } from './wording.js';
import { evaluateLighthouse, evaluateRouteBundles, PERFORMANCE_BUDGETS } from './perf/budgets.js';
import { findLiteralChildren } from './lint/literalText.js';
import { stripLocalePrefix, toIntlLocale } from '../../i18n/locales.js';

// Same relative depth from src/modules/m04_ui and dist/modules/m04_ui.
const WEB_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function loadEnglish(): Messages {
  return JSON.parse(readFileSync(join(WEB_ROOT, 'messages', 'en.json'), 'utf8')) as Messages;
}

const CATALOGUE: PriceCatalogueDto = {
  version: '2026-09-01',
  effectiveFrom: '2026-09-01',
  actions: { reveal: 1, reveal_bulk_each: 1, check_buyer: 0, export_row: 0 },
  countryMultipliers: { US: 1, DE: 1.5 },
  inrPerCredit: 20,
};

// --------------------------------------------------------------------------------------------
// Prices
// --------------------------------------------------------------------------------------------

test('computeCost applies country multiplier (rounded up per unit) and quantity', () => {
  const q = computeCost(CATALOGUE, 'reveal_bulk_each', { country: 'de', quantity: 20 });
  assert.equal(q.unitCredits, 2);
  assert.equal(q.credits, 40);
  assert.equal(q.multiplier, 1.5);
  assert.equal(q.country, 'DE');
  assert.equal(q.inr, 800);
  assert.equal(q.catalogueVersion, '2026-09-01');
});

test('computeCost: free actions and unknown countries', () => {
  const free = computeCost(CATALOGUE, 'check_buyer');
  assert.equal(free.isFree, true);
  assert.equal(free.credits, 0);
  const plain = computeCost(CATALOGUE, 'reveal', { country: 'FR' });
  assert.equal(plain.multiplier, 1);
  assert.equal(plain.credits, 1);
});

test('computeCost rejects unpriced actions and bad quantities', () => {
  const partial: PriceCatalogueDto = { ...CATALOGUE, actions: { reveal: 1 } };
  assert.throws(() => computeCost(partial, 'export_row'), PriceUnavailableError);
  assert.throws(() => computeCost(CATALOGUE, 'reveal', { quantity: 0 }), PriceUnavailableError);
  assert.throws(() => computeCost(CATALOGUE, 'reveal', { quantity: 1.5 }), PriceUnavailableError);
});

test('resolveCost: fetch failure means unavailable, never a guessed price', () => {
  assert.deepEqual(resolveCost(CATALOGUE, 'network', 'reveal'), { state: 'unavailable', reason: 'network' });
  assert.deepEqual(resolveCost(null, null, 'reveal'), { state: 'loading' });
  const ready = resolveCost(CATALOGUE, null, 'reveal');
  assert.equal(ready.state, 'ready');
});

test('parseCatalogue accepts snake_case yaml shape and validates numbers', () => {
  const parsed = parseCatalogue({
    version: 7,
    effective_from: '2026-09-01',
    actions: { reveal: 1 },
    country_multipliers: { us: 1.2 },
  });
  assert.equal(parsed.version, '7');
  assert.deepEqual(parsed.countryMultipliers, { US: 1.2 });
  assert.equal(parsed.inrPerCredit, null);
  assert.throws(() => parseCatalogue({ version: 'v', actions: { reveal: -1 } }), PriceUnavailableError);
  assert.throws(() => parseCatalogue({ actions: { reveal: 1 } }), PriceUnavailableError);
  assert.throws(() => parseCatalogue({ version: 'v', actions: {}, country_multipliers: {} }), PriceUnavailableError);
});

function fakeFetch(responses: Array<{ status: number; body?: unknown } | 'throw'>): { fetchImpl: FetchLike; calls: Array<Record<string, string>> } {
  const calls: Array<Record<string, string>> = [];
  const fetchImpl: FetchLike = async (_input, init) => {
    calls.push(init?.headers ?? {});
    const next = responses.shift();
    if (next === undefined || next === 'throw') throw new Error('offline');
    return { status: next.status, ok: next.status >= 200 && next.status < 300, json: async () => next.body };
  };
  return { fetchImpl, calls };
}

test('price client caches per version, revalidates with If-None-Match, and dedupes requests', async () => {
  let clock = 0;
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, body: { ...CATALOGUE } },
    { status: 304 },
  ]);
  const client = createPriceClient({ fetchImpl, ttlMs: 1000, now: () => clock });

  const [a, b] = await Promise.all([client.getCatalogue(), client.getCatalogue()]);
  assert.equal(calls.length, 1, 'concurrent calls share one request');
  assert.equal(a, b);
  assert.equal(client.peek(), a);

  clock = 500;
  await client.getCatalogue();
  assert.equal(calls.length, 1, 'within TTL: no request');

  clock = 2000;
  assert.equal(client.peek(), null, 'stale cache is not peeked');
  const c = await client.getCatalogue();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.['if-none-match'], '"2026-09-01"');
  assert.equal(c, a, 'same version keeps object identity');
});

test('price client surfaces network and HTTP failures as PriceUnavailableError', async () => {
  const offline = createPriceClient({ fetchImpl: fakeFetch(['throw']).fetchImpl });
  await assert.rejects(offline.getCatalogue(), (err: unknown) => err instanceof PriceUnavailableError && err.reason === 'network');
  const down = createPriceClient({ fetchImpl: fakeFetch([{ status: 503 }]).fetchImpl });
  await assert.rejects(down.getCatalogue(), (err: unknown) => err instanceof PriceUnavailableError && err.reason === 'http_503');
});

test('price client prime() avoids a request', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const client = createPriceClient({ fetchImpl });
  client.prime(CATALOGUE);
  assert.equal(await client.getCatalogue(), CATALOGUE);
  assert.equal(calls.length, 0);
});

// --------------------------------------------------------------------------------------------
// Navigation
// --------------------------------------------------------------------------------------------

test('navigation follows design §3.2 order', () => {
  assert.deepEqual(
    NAV_ITEMS.map((i) => i.id),
    ['home', 'products', 'markets', 'buyers', 'myBuyers', 'check', 'learn', 'account'],
  );
  const { primary, overflow } = partitionNav();
  assert.equal(primary.length, 4);
  assert.equal(primary.length + overflow.length, NAV_ITEMS.length);
});

test('active nav item handles locale prefixes and nested paths', () => {
  assert.equal(activeNavId('/'), 'home');
  assert.equal(activeNavId('/en'), 'home');
  assert.equal(activeNavId('/en/markets/DE'), 'markets');
  assert.equal(activeNavId('/my-buyers'), 'myBuyers');
  assert.equal(activeNavId('/buyers-guide'), null);
  const buyers = NAV_ITEMS.find((i) => i.id === 'buyers');
  assert.ok(buyers);
  assert.equal(isNavItemActive('/buyers/', buyers), true);
  assert.equal(stripLocalePrefix('/en/learn?x=1'), '/learn');
  assert.equal(toIntlLocale('en'), 'en-IN');
});

// --------------------------------------------------------------------------------------------
// Message catalogue
// --------------------------------------------------------------------------------------------

test('en.json: every nav key and client namespace exists', () => {
  const en = loadEnglish();
  for (const item of NAV_ITEMS) {
    assert.ok(getMessage(en, item.labelKey), `missing ${item.labelKey}`);
    assert.ok(getMessage(en, item.descriptionKey), `missing ${item.descriptionKey}`);
  }
  const picked = pickMessages(en, ['cost', 'nav']);
  assert.deepEqual(Object.keys(picked).sort(), ['cost', 'nav']);
  for (const key of ['cost.free', 'cost.credits', 'cost.unavailable', 'disclaimer.hs', 'disclaimer.trust', 'disclaimer.sanctions', 'disclaimer.coverage', 'signupGate.reason.default']) {
    assert.ok(getMessage(en, key), `missing ${key}`);
  }
});

test('en.json: M15 coverage explanation keys resolve (with .country_level stripped)', () => {
  const en = loadEnglish();
  for (const key of ['coverage.strong.customs', 'coverage.partial.web_only', 'coverage.partial.few', 'coverage.limited', 'coverage.limited.country_level']) {
    const split = splitCoverageKey(key);
    assert.ok(getMessage(en, split.key), `missing ${split.key}`);
  }
});

test('en.json: no forbidden trust wording anywhere, and no hard-coded rupee amounts', () => {
  const flat = flattenMessages(loadEnglish());
  for (const [key, value] of flat) {
    assert.equal(containsForbiddenTrustWording(value), false, `${key} contains forbidden wording`);
    assert.doesNotMatch(value, /₹\s*\d/, `${key} hard-codes a rupee amount`);
  }
});

test('catalogue diff reports missing, extra and ICU argument mismatches', () => {
  assert.deepEqual([...argumentsOf('{credits, plural, one {# credit} other {# credits}} ({inr})')].sort(), ['credits', 'inr']);
  assert.deepEqual([...argumentsOf('{n, plural, one {item} other {items for {who}}}')].sort(), ['n', 'who']);
  const base: Messages = { a: { b: 'Hi {name}', c: 'x' } };
  const other: Messages = { a: { b: 'नमस्ते', d: 'y' } };
  assert.deepEqual(diffCatalogues(base, other), { missing: ['a.c'], extra: ['a.d'], argumentMismatch: ['a.b'] });
  assert.deepEqual(diffCatalogues(loadEnglish(), loadEnglish()), { missing: [], extra: [], argumentMismatch: [] });
});

// --------------------------------------------------------------------------------------------
// Trust wording
// --------------------------------------------------------------------------------------------

test('guardTrustText throws outside production and falls back in production', () => {
  assert.equal(guardTrustText('Trust: High', 'x', 'test'), 'Trust: High');
  assert.throws(() => guardTrustText('Verified buyer', 'Passed', 'development'));
  assert.equal(guardTrustText('Genuine company', 'Passed', 'production'), 'Passed');
  assert.equal(guardTrustText('Genuine', 'guaranteed', 'production'), '');
});

test('trust checks are ordered and counted', () => {
  const result = {
    level: 'medium' as const,
    checks: [
      { id: 'sanctions', outcome: 'pass' as const, checkedAt: null },
      { id: 'custom', outcome: 'unknown' as const, checkedAt: null },
      { id: 'registered_entity', outcome: 'pass' as const, checkedAt: null },
      { id: 'domain_age', outcome: 'fail' as const, checkedAt: null },
    ],
  };
  assert.deepEqual(orderTrustChecks(result.checks).map((c) => c.id), ['registered_entity', 'domain_age', 'sanctions', 'custom']);
  assert.deepEqual(trustCounts(result), { passed: 2, total: 4 });
});

// --------------------------------------------------------------------------------------------
// Performance budgets
// --------------------------------------------------------------------------------------------

test('budgets flag LCP, CLS and JS breaches', () => {
  assert.deepEqual(evaluateLighthouse({ route: '/', lcpMs: 2400, cls: 0.05, scriptTransferBytes: 120_000 }), []);
  const breaches = evaluateLighthouse({ route: '/', lcpMs: 3000, cls: 0.2, scriptTransferBytes: 200_000 });
  assert.deepEqual(breaches.map((b) => b.metric).sort(), ['cls', 'js', 'lcp']);
  assert.equal(PERFORMANCE_BUDGETS.jsGzipBytesPerRoute, 174_080);
  assert.deepEqual(evaluateRouteBundles({ '/': 100_000, '/markets': 180_000 }).map((b) => b.route), ['/markets']);
});

// --------------------------------------------------------------------------------------------
// Literal UI text
// --------------------------------------------------------------------------------------------

test('findLiteralChildren flags literal children but not props, keys or comments', () => {
  const src = [
    "h('p', { className: 'text-sm' }, t('x'));",
    "h('span', null, 'Hello there');",
    "// h('span', null, 'commented out')",
    "h('span', null, ' · ');",
    'h(Link, { href: "/a" }, `Go ${name}`);',
  ].join('\n');
  const found = findLiteralChildren(src);
  assert.deepEqual(found.map((v) => [v.line, v.text]), [
    [2, 'Hello there'],
    [5, 'Go '],
  ]);
});

test('M04 components contain no literal UI text', () => {
  const dirs = [join(WEB_ROOT, 'src', 'modules', 'm04_ui', 'components'), join(WEB_ROOT, 'src', 'app', '[locale]')];
  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const violations = findLiteralChildren(readFileSync(join(dir, file), 'utf8'));
      assert.deepEqual(violations, [], `${file} renders literal text`);
    }
  }
});
