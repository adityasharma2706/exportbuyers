/**
 * M16 IF-16a unit tests (node:test) over in-memory M14/M15 repos and an in-memory cache.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setMarketRepoForTesting, type MarketRowRecord } from '../m14_markets/index.js';
import { setCoverageRepoForTesting, type CoverageCellRecord } from '../m15_coverage/index.js';
import { setMarketCacheStoreForTesting, type MarketCacheStore } from './cache.js';
import { competitorSuppliers, findMarkets, ftaCoversChapter, guidanceFor, parseMarketCode } from './service.js';

function marketRec(partial: Partial<MarketRowRecord> & Pick<MarketRowRecord, 'country' | 'rank'>): MarketRowRecord {
  return {
    hs6: '630260',
    data_year: 2025,
    import_value_usd: '250000000',
    cagr_5y: 0.08,
    india_share: 0.12,
    top_suppliers: [
      { country: 'CN', share: 0.4 },
      { country: 'IN', share: 0.12 },
      { country: 'PK', share: 0.2 },
    ],
    fta_ref: null,
    score: 0.7,
    why_text: 'Large and growing market.',
    why_input_hash: 'a'.repeat(64),
    hs_version: 'HS2022',
    built_at: '2026-09-01T00:00:00.000Z',
    fta_partner: null,
    fta_agreement: null,
    fta_in_force_from: null,
    fta_hs_scope: null,
    fta_notes: null,
    fta_source_url: null,
    ...partial,
  };
}

function coverageRec(country: string, label: string, key: string, heading = '6302'): CoverageCellRecord {
  return {
    country,
    hs_heading: heading,
    source_types: ['customs'],
    company_count: 80,
    fresh_company_count: 60,
    label,
    explanation_key: key,
    params: { count: 60, sources: ['customs'] },
    rule_version: 1,
    computed_at: '2026-09-01T00:00:00.000Z',
  };
}

class MapStore implements MarketCacheStore {
  readonly map = new Map<string, { value: string; ttl: number }>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key)?.value ?? null;
  }
  async set(key: string, value: string, ttlSec: number): Promise<void> {
    this.map.set(key, { value, ttl: ttlSec });
  }
}

let store: MapStore;
let marketCalls = 0;

beforeEach(() => {
  store = new MapStore();
  marketCalls = 0;
  setMarketCacheStoreForTesting(store);
});

function withMarkets(rows: MarketRowRecord[]): void {
  setMarketRepoForTesting({
    async rowsForCode(code) {
      marketCalls++;
      return rows.filter((r) => r.hs6 === code);
    },
    async enqueueWhy() {},
  });
}

function withCoverage(rows: CoverageCellRecord[]): void {
  setCoverageRepoForTesting({
    async cellsFor(country, heading) {
      return rows.filter((r) => r.country === country && (r.hs_heading === heading || r.hs_heading === '*'));
    },
  });
}

test('rows carry market numbers, competitors without India, FTA and a coverage label', async () => {
  withMarkets([
    marketRec({
      country: 'AE',
      rank: 1,
      fta_ref: 'IN-AE-CEPA',
      fta_partner: 'AE',
      fta_agreement: 'India–UAE CEPA',
      fta_in_force_from: '2022-05-01',
      fta_hs_scope: 'all',
    }),
    marketRec({ country: 'US', rank: 2, why_text: null }),
  ]);
  withCoverage([coverageRec('AE', 'partial', 'coverage.partial.few'), coverageRec('US', 'strong', 'coverage.strong.customs', '*')]);

  const res = await findMarkets('63026000');
  assert.equal(res.code, '630260');
  assert.equal(res.dataYear, 2025);
  assert.equal(res.disclaimerKey, 'disclaimer.coverage');
  assert.equal(res.guidance, null);
  assert.deepEqual(res.rows.map((r) => r.country), ['AE', 'US']);

  const ae = res.rows[0]!;
  assert.equal(ae.importValueUsd, 250_000_000);
  assert.equal(ae.indiaShare, 0.12);
  assert.deepEqual(ae.topSuppliers.map((s) => s.country), ['CN', 'PK']);
  assert.equal(ae.fta?.agreement, 'India–UAE CEPA');
  assert.equal(ae.coverage.label, 'partial');
  assert.equal(ae.coverage.hsHeading, '6302');

  const us = res.rows[1]!;
  assert.equal(us.why, null);
  assert.equal(us.whyFallback.params.importValueUsdMillions, 250);
  assert.equal(us.coverage.explanationKey, 'coverage.strong.customs.country_level');
});

test('a country without any coverage row is honestly Limited', async () => {
  withMarkets([marketRec({ country: 'DE', rank: 1 })]);
  withCoverage([]);
  const res = await findMarkets('630260');
  assert.equal(res.rows[0]!.coverage.label, 'limited');
});

test('answers are cached per (hs6, dataYear); pending "why" shortens the TTL', async () => {
  withMarkets([marketRec({ country: 'DE', rank: 1 })]);
  withCoverage([]);
  await findMarkets('630260');
  await findMarkets('6302.60');
  assert.equal(marketCalls, 1);
  assert.equal(store.map.get('m16:markets:v1:ptr:630260')?.value, '2025');
  assert.equal(store.map.get('m16:markets:v1:630260:2025')?.ttl, 3600);

  store.map.clear();
  withMarkets([marketRec({ country: 'DE', rank: 1, why_text: null })]);
  await findMarkets('630260');
  assert.equal(store.map.get('m16:markets:v1:630260:2025')?.ttl, 300);
});

test('no rows → empty list with guidance to try the parent heading', async () => {
  withMarkets([]);
  withCoverage([]);
  const res = await findMarkets('630260', 'HS2022');
  assert.deepEqual(res.rows, []);
  assert.equal(res.dataYear, null);
  assert.equal(res.version, 'HS2022');
  assert.deepEqual(res.guidance, { key: 'marketFinder.noRowsTryParent', parentCode: '6302' });
  assert.deepEqual(guidanceFor('6302', 'hs4'), { key: 'marketFinder.noRows', parentCode: null });
});

test('invalid codes are VALIDATION errors', () => {
  assert.throws(() => parseMarketCode('63'), (e: unknown) => (e as { code?: string }).code === 'VALIDATION');
  assert.throws(() => parseMarketCode(undefined), (e: unknown) => (e as { code?: string }).code === 'VALIDATION');
  assert.equal(parseMarketCode('6302').key, '6302__');
});

test('FTA scope and competitor helpers', () => {
  assert.equal(ftaCoversChapter('all', '630260'), true);
  assert.equal(ftaCoversChapter('01-24,28', '630260'), false);
  assert.equal(ftaCoversChapter('50-63', '630260'), true);
  assert.equal(ftaCoversChapter('63', '630260'), true);
  assert.deepEqual(
    competitorSuppliers(
      [
        { country: 'IN', share: 0.5 },
        { country: 'BD', share: 0.1 },
        { country: 'CN', share: 0.3 },
      ],
      'US',
    ).map((s) => s.country),
    ['CN', 'BD'],
  );
});
