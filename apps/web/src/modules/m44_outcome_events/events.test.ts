/**
 * M44 unit tests: `buildOutcomeEventRows` (LLD M44's own EV-08 -> analytics.outcome_event
 * mapping), against a plain in-memory payload/doc fixture — no DB, no event bus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PipelineStatusChangedPayload } from '../m33_pipeline/index.js';
import { buildOutcomeEventRows } from './events.js';

function payloadFor(toStatus: PipelineStatusChangedPayload['toStatus'], fromStatus: PipelineStatusChangedPayload['fromStatus'] = 'contacted'): PipelineStatusChangedPayload {
  return {
    v: 1,
    entryId: 'e1111111-1111-7111-8111-111111111111',
    accountId: 'a1111111-1111-7111-8111-111111111111',
    workspaceId: 'w1111111-1111-7111-8111-111111111111',
    companyId: 'c1111111-1111-7111-8111-111111111111',
    fromStatus,
    toStatus,
    source: 'user',
    at: '2026-01-15T10:00:00.000Z',
  };
}

test('writes nothing for a to_status outside {replied, in_discussion, order_won}', () => {
  const rows = buildOutcomeEventRows(payloadFor('sample_sent'), { country: 'US', hs_headings: ['6302'] });
  assert.equal(rows.length, 0);
});

test('writes one row per hs_heading the company profile doc carries', () => {
  const rows = buildOutcomeEventRows(payloadFor('replied'), { country: 'US', hs_headings: ['6302', '6306'] });
  assert.equal(rows.length, 2);
  const headings = rows.map((r) => r.hsHeading).sort();
  assert.deepEqual(headings, ['6302', '6306']);
  for (const row of rows) {
    assert.equal(row.accountId, 'a1111111-1111-7111-8111-111111111111');
    assert.equal(row.companyId, 'c1111111-1111-7111-8111-111111111111');
    assert.equal(row.country, 'US');
    assert.equal(row.fromStatus, 'contacted');
    assert.equal(row.toStatus, 'replied');
    assert.ok(row.id.length > 0);
  }
  // No two rows share an id.
  assert.equal(new Set(rows.map((r) => r.id)).size, 2);
});

test('deduplicates repeated hs_headings', () => {
  const rows = buildOutcomeEventRows(payloadFor('order_won'), { country: 'DE', hs_headings: ['6302', '6302'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hsHeading, '6302');
});

test('writes one row with a null hs_heading when the company has none yet', () => {
  const rows = buildOutcomeEventRows(payloadFor('in_discussion'), { country: 'GB', hs_headings: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hsHeading, null);
  assert.equal(rows[0]!.country, 'GB');
  assert.equal(rows[0]!.toStatus, 'in_discussion');
});
