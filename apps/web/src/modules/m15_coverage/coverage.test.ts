/**
 * M15 IF-15a unit tests (node:test) over an in-memory repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coverage, normalizeHeading, setCoverageRepoForTesting } from './coverage.js';
import type { CoverageCellRecord } from './types.js';

function rec(partial: Partial<CoverageCellRecord> & Pick<CoverageCellRecord, 'hs_heading'>): CoverageCellRecord {
  return {
    country: 'DE',
    source_types: ['customs'],
    company_count: 80,
    fresh_company_count: 60,
    label: 'strong',
    explanation_key: 'coverage.strong.customs',
    params: { count: 60, sources: ['customs'] },
    rule_version: 1,
    computed_at: '2026-09-01T00:00:00.000Z',
    ...partial,
  };
}

function withRows(rows: CoverageCellRecord[]): void {
  setCoverageRepoForTesting({
    async cellsFor(country, heading) {
      return rows.filter((r) => r.country === country && (r.hs_heading === heading || r.hs_heading === '*'));
    },
  });
}

test('heading row wins over the country fallback', async () => {
  withRows([rec({ hs_heading: '0901' }), rec({ hs_heading: '*', label: 'partial', explanation_key: 'coverage.partial.few' })]);
  const c = await coverage('de', '09011190');
  assert.equal(c.level, 'heading');
  assert.equal(c.hsHeading, '0901');
  assert.equal(c.label, 'strong');
  assert.equal(c.explanationKey, 'coverage.strong.customs');
  assert.deepEqual(c.params, { count: 60, sources: ['customs'] });
});

test('falls back to the country row with a .country_level key', async () => {
  withRows([rec({ hs_heading: '*', label: 'partial', explanation_key: 'coverage.partial.web_only', company_count: '12', fresh_company_count: '11' })]);
  const c = await coverage('DE', '0902');
  assert.equal(c.level, 'country');
  assert.equal(c.label, 'partial');
  assert.equal(c.explanationKey, 'coverage.partial.web_only.country_level');
  assert.equal(c.freshCompanyCount, 11);
});

test('no rows → synthetic limited', async () => {
  withRows([]);
  const c = await coverage('FR', '0901');
  assert.equal(c.level, 'none');
  assert.equal(c.label, 'limited');
  assert.equal(c.explanationKey, 'coverage.limited');
  assert.equal(c.computedAt, undefined);
});

test('malformed rows degrade to limited', async () => {
  withRows([rec({ hs_heading: '0901', label: 'excellent' })]);
  const c = await coverage('DE', '0901');
  assert.equal(c.label, 'limited');
  assert.equal(c.explanationKey, 'coverage.limited');
});

test('input validation', async () => {
  assert.equal(normalizeHeading('0901.11'), '0901');
  assert.throws(() => normalizeHeading('09'));
  await assert.rejects(coverage('Germany', '0901'));
  setCoverageRepoForTesting(undefined);
});
