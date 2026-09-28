/**
 * M40 unit tests (no database): the LLD M40 decision rule, both in isolation and driven by
 * M12's real `correlate()` over an in-memory HsRepo, so the interpretation of `{code, relation}`
 * results is checked against the actual correlation-table semantics, not a hand-picked shape.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { correlate, setHsRepoForTesting, type HsCodeRow, type HsCorrelationRow, type HsRepo } from '../m12_hs/index.js';
import { decideOutcome } from './decide.js';

function code(version: string, c: string, parent: string | null): HsCodeRow {
  const levels: Record<number, string> = { 2: 'chapter', 4: 'heading', 6: 'subheading', 8: 'national8' };
  return {
    version,
    code: c,
    level: levels[c.length] ?? 'invalid',
    parent_code: parent,
    description: `desc ${c}`,
    description_en_simple: null,
    export_policy: null,
    policy_conditions: null,
    policy_source_url: null,
  };
}

function memRepo(codes: HsCodeRow[], corr: HsCorrelationRow[]): HsRepo {
  return {
    async children(version, parent) {
      return codes.filter((r) => r.version === version && (parent === null ? r.level === 'chapter' : r.parent_code === parent));
    },
    async one(version, c) {
      return codes.find((r) => r.version === version && r.code === c);
    },
    async nearest() {
      return [];
    },
    async currentVersion() {
      return undefined;
    },
    async hasCorrelationTable(f, t) {
      return corr.some((r) => r.from_version === f && r.to_version === t);
    },
    async correlationRows(f, t, column, c, exact) {
      return corr.filter((r) => r.from_version === f && r.to_version === t && (exact ? r[column] === c : r[column].startsWith(c)));
    },
  };
}

const CODES = [
  code('HS2022', '010121', '0101'),
  code('HS2022', '010129', '0101'),
  code('HS2027', '010121', '0101'),
  code('HS2027', '010191', '0101'),
  code('HS2027', '010199', '0101'),
];

// 010121 carries over 1:1; 010129 was split into two headings in HS2027.
const CORR: HsCorrelationRow[] = [
  { from_version: 'HS2022', from_code: '010121', to_version: 'HS2027', to_code: '010121', relation: '1:1' },
  { from_version: 'HS2022', from_code: '010129', to_version: 'HS2027', to_code: '010191', relation: '1:n' },
  { from_version: 'HS2022', from_code: '010129', to_version: 'HS2027', to_code: '010199', relation: '1:n' },
];

describe('m40 decideOutcome', () => {
  afterEach(() => setHsRepoForTesting(undefined));

  it('is a silent update when the code correlates 1:1 to itself', async () => {
    setHsRepoForTesting(memRepo(CODES, CORR));
    const candidates = await correlate('HS2022', '010121', 'HS2027');
    assert.deepEqual(candidates, [{ code: '010121', relation: '1:1' }]);
    assert.equal(decideOutcome('010121', candidates), 'silent_update');
  });

  it('flags for reconfirmation when a code splits into several (1:n)', async () => {
    setHsRepoForTesting(memRepo(CODES, CORR));
    const candidates = await correlate('HS2022', '010129', 'HS2027');
    assert.equal(candidates.length, 2);
    assert.equal(decideOutcome('010129', candidates), 'flag');
  });

  it('flags for reconfirmation when there is no candidate at all', () => {
    assert.equal(decideOutcome('999999', []), 'flag');
  });

  it('flags for reconfirmation on a 1:1 match to a *different* code (never silently renumbers)', () => {
    assert.equal(decideOutcome('010129', [{ code: '010199', relation: '1:1' }]), 'flag');
  });

  it('a 1:1 self-match mixed with anything else still flags (defence in depth)', () => {
    assert.equal(
      decideOutcome('010121', [
        { code: '010121', relation: '1:1' },
        { code: '010199', relation: '1:1' },
      ]),
      'flag',
    );
  });
});
