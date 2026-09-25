/**
 * M08 unit tests (no database): register row validation, licence decisions, attribution and
 * export partitioning over an injected loader.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AppError } from '../m01_platform/index.js';
import {
  attributionsFor,
  getSource,
  partitionExportable,
  rowToEntry,
  setSourceLoaderForTesting,
  sourceAllows,
  type SourceRow,
} from './index.js';

function row(over: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 'registry.gb.ch',
    source_type: 'registry',
    can_store: true,
    can_display: true,
    can_export: true,
    retention_days: null,
    attribution_text: 'Contains public sector information licensed under the Open Government Licence v3.0',
    personal_data_class: 'named_person',
    allowed_regions: ['GB'],
    status: 'active',
    notes: null,
    updated_at: null,
    ...over,
  };
}

function useRows(rows: SourceRow[]): { calls: number } {
  const counter = { calls: 0 };
  setSourceLoaderForTesting({
    async one(id) {
      counter.calls += 1;
      return rows.find((r) => r.id === id);
    },
    async all() {
      return rows;
    },
  });
  return counter;
}

afterEach(() => setSourceLoaderForTesting(undefined));

describe('m08 source register (TS)', () => {
  it('maps and validates rows', () => {
    const e = rowToEntry(row({ allowed_regions: ['gb'] }));
    assert.deepEqual(e.allowedRegions, ['GB']);
    assert.equal(e.sourceType, 'registry');
    assert.throws(() => rowToEntry(row({ status: 'maybe' })), AppError);
    assert.throws(() => rowToEntry(row({ allowed_regions: ['Britain'] })), AppError);
  });

  it('getSource throws NOT_FOUND for unregistered ids and caches lookups', async () => {
    const counter = useRows([row()]);
    await assert.rejects(getSource('linkedin'), (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND');
    await getSource('registry.gb.ch');
    await getSource('registry.gb.ch');
    assert.equal(counter.calls, 2);
  });

  it('licence decisions respect status, export rights and regions', () => {
    const ch = rowToEntry(row());
    assert.equal(sourceAllows(ch, 'display', 'GB'), true);
    assert.equal(sourceAllows(ch, 'export', 'gb'), true);
    assert.equal(sourceAllows(ch, 'display', 'US'), false);
    const comtrade = rowToEntry(row({ id: 'market_stats.un.comtrade', can_export: false, allowed_regions: ['*'] }));
    assert.equal(sourceAllows(comtrade, 'display'), true);
    assert.equal(sourceAllows(comtrade, 'export'), false);
    const li = rowToEntry(
      row({ id: 'linkedin', status: 'prohibited', can_store: false, can_display: false, can_export: false }),
    );
    assert.equal(sourceAllows(li, 'display'), false);
  });

  it('builds attribution lines and partitions exportable sources', async () => {
    useRows([
      row(),
      row({ id: 'market_stats.un.comtrade', can_export: false, attribution_text: 'Source: UN Comtrade', allowed_regions: ['*'] }),
      row({ id: 'linkedin', status: 'prohibited', can_store: false, can_display: false, can_export: false }),
    ]);
    const lines = await attributionsFor(['registry.gb.ch', 'market_stats.un.comtrade', 'registry.gb.ch', 'linkedin']);
    assert.equal(lines.length, 2);
    const p = await partitionExportable(['registry.gb.ch', 'market_stats.un.comtrade', 'linkedin', 'nope.x']);
    assert.deepEqual(p.exportable, ['registry.gb.ch']);
    assert.deepEqual(
      p.blocked.map((b) => b.reason),
      ['no_export_right', 'prohibited', 'not_registered'],
    );
  });
});
