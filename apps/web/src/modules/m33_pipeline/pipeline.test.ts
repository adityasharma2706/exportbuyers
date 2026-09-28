/**
 * M33 unit tests for pure logic (no database): companyIds / status / note validation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../m01_platform/index.js';
import { setPipelineConfig } from './config.js';
import { statusLabel } from './labels.js';
import { parseCompanyIds, parseNoteBody, parseShortlistStatus, parseStatusPatch } from './validate.js';

function field(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'VALIDATION');
    return e.details?.field as string | undefined;
  }
  assert.fail('expected a VALIDATION error');
}

const UUID_A = '018f3b2a-1111-7000-8000-000000000001';
const UUID_B = '018f3b2a-2222-7000-8000-000000000002';

describe('parseCompanyIds', () => {
  it('de-duplicates and lowercases', () => {
    assert.deepEqual(parseCompanyIds([UUID_A, UUID_A.toUpperCase(), UUID_B]), [UUID_A, UUID_B]);
  });

  it('rejects a non-uuid entry', () => {
    assert.equal(field(() => parseCompanyIds(['not-a-uuid'])), 'companyIds');
  });

  it('rejects an empty array', () => {
    assert.equal(field(() => parseCompanyIds([])), 'companyIds');
  });

  it('enforces the 200 cap (LLD M33 API: "companyIds: string[] ≤ 200")', () => {
    setPipelineConfig({ maxBulkAdd: 2 });
    try {
      assert.equal(field(() => parseCompanyIds([UUID_A, UUID_B, UUID_A.replace('1', '3')])), 'companyIds');
    } finally {
      setPipelineConfig({ maxBulkAdd: 200 });
    }
  });
});

describe('parseShortlistStatus / parseStatusPatch', () => {
  it('accepts every LLD-listed status', () => {
    for (const s of ['to_contact', 'contacted', 'replied', 'in_discussion', 'sample_sent', 'order_won', 'not_interested']) {
      assert.equal(parseShortlistStatus(s), s);
    }
  });

  it('rejects an unknown status', () => {
    assert.equal(field(() => parseShortlistStatus('won')), 'status');
  });

  it('requires at least one field', () => {
    assert.throws(() => parseStatusPatch({}), AppError);
    assert.throws(() => parseStatusPatch({ unknown: 1 }), AppError);
  });

  it('accepts a status-only or nextActionAt-only patch', () => {
    assert.deepEqual(parseStatusPatch({ status: 'contacted' }), { status: 'contacted' });
    const withReminder = parseStatusPatch({ nextActionAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(withReminder.nextActionAt, '2026-01-01T00:00:00.000Z');
  });
});

describe('parseNoteBody', () => {
  it('trims and rejects an empty body', () => {
    assert.equal(parseNoteBody('  hello  '), 'hello');
    assert.equal(field(() => parseNoteBody('   ')), 'body');
  });

  it('enforces the 5000-char cap (LLD M33 schema: note.body length <= 5000)', () => {
    setPipelineConfig({ noteMaxLength: 10 });
    try {
      assert.equal(field(() => parseNoteBody('a'.repeat(11))), 'body');
      assert.equal(parseNoteBody('a'.repeat(10)).length, 10);
    } finally {
      setPipelineConfig({ noteMaxLength: 5000 });
    }
  });
});

describe('statusLabel', () => {
  it('has a label for every status', () => {
    assert.equal(statusLabel('to_contact'), 'To contact');
    assert.equal(statusLabel('order_won'), 'Order won');
  });
});
