/**
 * M12 unit tests (no database): browse / lookup / vectorSearch / currentVersion / correlate over
 * an in-memory HsRepo.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AppError } from '../m01_platform/index.js';
import {
  HS_EMBEDDING_DIM,
  browse,
  correlate,
  currentVersion,
  lookup,
  normalizeCode,
  setHsRepoForTesting,
  toVectorLiteral,
  vectorSearch,
  type HsCodeRow,
  type HsCorrelationRow,
  type HsRepo,
} from './index.js';

function code(version: string, c: string, parent: string | null, extra: Partial<HsCodeRow> = {}): HsCodeRow {
  const levels: Record<number, string> = { 2: 'chapter', 4: 'heading', 6: 'subheading', 8: 'national8' };
  const level = levels[c.length] ?? 'invalid';
  return {
    version,
    code: c,
    level,
    parent_code: parent,
    description: `desc ${c}`,
    description_en_simple: null,
    export_policy: null,
    policy_conditions: null,
    policy_source_url: null,
    ...extra,
  };
}

function memRepo(codes: HsCodeRow[], corr: HsCorrelationRow[], current: Record<string, string>): HsRepo {
  return {
    async children(version, parent) {
      return codes.filter((r) => r.version === version && (parent === null ? r.level === 'chapter' : r.parent_code === parent));
    },
    async one(version, c) {
      return codes.find((r) => r.version === version && r.code === c);
    },
    async nearest(version, _e, k, levels) {
      return codes
        .filter((r) => r.version === version && (!levels || levels.includes(r.level as never)))
        .slice(0, k)
        .map((r) => ({ ...r, similarity: '0.9' }));
    },
    async currentVersion(family) {
      return current[family];
    },
    async hasCorrelationTable(f, t) {
      return corr.some((r) => r.from_version === f && r.to_version === t);
    },
    async correlationRows(f, t, column, c, exact) {
      return corr.filter(
        (r) => r.from_version === f && r.to_version === t && (exact ? r[column] === c : r[column].startsWith(c)),
      );
    },
  };
}

const CODES = [
  code('HS2022', '01', null),
  code('HS2022', '0101', '01'),
  code('HS2022', '010121', '0101'),
  code('HS2022', '010129', '0101'),
  code('ITCHS2022', '01012100', '010121', {
    export_policy: 'free',
    policy_source_url: 'https://www.dgft.gov.in/itchs.xlsx',
  }),
];

const CORR: HsCorrelationRow[] = [
  { from_version: 'HS2022', from_code: '010121', to_version: 'HS2027', to_code: '010121', relation: '1:1' },
  { from_version: 'HS2022', from_code: '010129', to_version: 'HS2027', to_code: '010131', relation: '1:n' },
  { from_version: 'HS2022', from_code: '010129', to_version: 'HS2027', to_code: '010139', relation: '1:n' },
  { from_version: 'HS2022', from_code: '020110', to_version: 'HS2027', to_code: '020100', relation: 'n:1' },
  { from_version: 'HS2022', from_code: '020120', to_version: 'HS2027', to_code: '020100', relation: 'n:1' },
];

describe('m12 hs read API', () => {
  afterEach(() => setHsRepoForTesting(undefined));

  it('normalizes codes and rejects bad ones', () => {
    assert.equal(normalizeCode('0101.21'), '010121');
    assert.throws(() => normalizeCode('01012'), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
  });

  it('browses the ITC-HS tree through the corresponding HS version', async () => {
    setHsRepoForTesting(memRepo(CODES, CORR, { HS: 'HS2022', ITCHS: 'ITCHS2022' }));
    assert.deepEqual((await browse('ITCHS2022', null)).map((n) => n.code), ['01']);
    assert.deepEqual((await browse('ITCHS2022', '0101')).map((n) => n.code), ['010121', '010129']);
    const leaf = await browse('ITCHS2022', '010121');
    assert.equal(leaf[0]!.exportPolicy, 'free');
    assert.equal((await lookup('ITCHS2022', '0101'))?.version, 'HS2022');
    assert.equal(await lookup('HS2022', '01012100'), null);
  });

  it('reports current versions per level', async () => {
    setHsRepoForTesting(memRepo(CODES, CORR, { HS: 'HS2027' }));
    assert.equal(await currentVersion('heading'), 'HS2027');
    await assert.rejects(currentVersion('national8'), (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND');
  });

  it('validates vector search input', async () => {
    setHsRepoForTesting(memRepo(CODES, CORR, {}));
    await assert.rejects(vectorSearch('HS2022', [1, 2, 3]), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
    const res = await vectorSearch('HS2022', new Array<number>(HS_EMBEDDING_DIM).fill(0.01), 30, { levels: ['subheading'] });
    assert.deepEqual(res.map((n) => n.code), ['010121', '010129']);
    assert.equal(res[0]!.similarity, 0.9);
    assert.equal(toVectorLiteral([1, -0, 0.5]), '[1,0,0.5]');
  });

  it('correlates directly, backwards and by aggregation', async () => {
    setHsRepoForTesting(memRepo(CODES, CORR, {}));
    assert.deepEqual(await correlate('HS2022', '010121', 'HS2027'), [{ code: '010121', relation: '1:1' }]);
    assert.deepEqual(await correlate('HS2027', '020100', 'HS2022'), [
      { code: '020110', relation: '1:n' },
      { code: '020120', relation: '1:n' },
    ]);
    // Heading 0101 → HS2027 heading 0101, fed only by 0101.
    assert.deepEqual(await correlate('HS2022', '0101', 'HS2027'), [{ code: '0101', relation: '1:1' }]);
    assert.deepEqual(await correlate('HS2022', '9999', 'HS2027'), []);
    await assert.rejects(correlate('HS2022', '0101', 'HS2017'), (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND');
  });
});
