/**
 * M07 unit tests for the pure logic (no database): onboarding / profile / workspace input
 * validation, IEC normalisation, default workspace names, anonymous carry-over parsing and
 * the idempotency request hash.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../m01_platform/index.js';
import { setTenancyConfig } from './config.js';
import { canonicalJson, idempotencyKeyOf, requestHash } from './idempotency.js';
import { textArray } from './repo.js';
import {
  defaultWorkspaceName,
  hsLevelForCode,
  normaliseIec,
  parseAnonCarryOver,
  parseCountries,
  parseHsSelection,
  parseOnboarding,
  parseProfilePatch,
  parseWorkspaceCreate,
  parseWorkspacePatch,
} from './validate.js';

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

describe('onboarding input', () => {
  const base = {
    businessName: '  Sharma   Handicrafts ',
    city: 'Jaipur',
    state: 'Rajasthan',
    whatTheyMake: 'Hand-block printed cotton bedsheets',
    exportExperience: 'none',
  };

  it('accepts the required fields and normalises text', () => {
    const r = parseOnboarding(base);
    assert.equal(r.businessName, 'Sharma Handicrafts');
    assert.equal(r.iec, null);
    assert.deepEqual(r.targetMarkets, []);
  });

  it('uppercases the IEC before validating it', () => {
    assert.equal(parseOnboarding({ ...base, iec: 'abcde1234f' }).iec, 'ABCDE1234F');
    assert.equal(normaliseIec(' ab cde1234f '), 'ABCDE1234F');
    assert.equal(normaliseIec(''), null);
    assert.equal(field(() => normaliseIec('ABC123')), 'iec');
    assert.equal(field(() => normaliseIec('ABCDE1234-')), 'iec');
  });

  it('rejects missing business name and bad export experience', () => {
    assert.equal(field(() => parseOnboarding({ ...base, businessName: '  ' })), 'businessName');
    assert.equal(field(() => parseOnboarding({ ...base, exportExperience: 'lots' })), 'exportExperience');
    assert.equal(field(() => parseOnboarding({ ...base, whatTheyMake: undefined })), 'whatTheyMake');
  });

  it('normalises and de-duplicates target markets', () => {
    const r = parseOnboarding({ ...base, targetMarkets: ['us', 'GB', 'us '] });
    assert.deepEqual(r.targetMarkets, ['US', 'GB']);
    assert.equal(field(() => parseOnboarding({ ...base, targetMarkets: ['USA'] })), 'targetMarkets');
  });
});

describe('countries', () => {
  it('enforces the per-workspace limit of 20', () => {
    const codes = Array.from({ length: 21 }, (_, i) => `A${String.fromCharCode(65 + i)}`);
    assert.equal(parseCountries(codes.slice(0, 20), 'countries', 20).length, 20);
    assert.equal(field(() => parseCountries(codes, 'countries', 20)), 'countries');
  });
});

describe('HS selection', () => {
  it('derives the level from the code length', () => {
    assert.equal(hsLevelForCode('52'), 'chapter');
    assert.equal(hsLevelForCode('5208'), 'heading');
    assert.equal(hsLevelForCode('520812'), 'subheading');
    assert.equal(hsLevelForCode('52081210'), 'national8');
    assert.equal(hsLevelForCode('52081'), null);
    assert.deepEqual(parseHsSelection({ code: '6302.21', version: 'hs2022' }), {
      code: '630221',
      level: 'subheading',
      version: 'HS2022',
    });
  });

  it('rejects a level that does not match the digits', () => {
    assert.equal(field(() => parseHsSelection({ code: '6302', level: 'subheading', version: 'HS2022' })), 'hs.level');
    assert.equal(field(() => parseHsSelection({ code: '6302', version: '2022' })), 'hs.version');
  });
});

describe('workspace names', () => {
  it('defaults to whatTheyMake truncated to 60 characters', () => {
    setTenancyConfig({ workspaceNameMaxLength: 60 });
    const long = 'x'.repeat(75);
    assert.equal(defaultWorkspaceName(long).length, 60);
    assert.equal(defaultWorkspaceName('  Cotton   towels '), 'Cotton towels');
  });

  it('validates create and patch bodies', () => {
    assert.equal(parseWorkspaceCreate({ name: 'Towels', countries: ['de'] }).countries?.[0], 'DE');
    assert.equal(field(() => parseWorkspaceCreate({ name: 'y'.repeat(61) })), 'name');
    assert.equal(field(() => parseWorkspacePatch({ hs_code: '1234' })), 'hs_code');
    assert.throws(() => parseWorkspacePatch({}), AppError);
  });
});

describe('profile patch', () => {
  it('allows clearing optional fields and editing every field', () => {
    const p = parseProfilePatch({ city: null, iec: 'aaaaa11111', website: 'example.com', senderEmail: 'Me@Example.com' });
    assert.equal(p.city, null);
    assert.equal(p.iec, 'AAAAA11111');
    assert.equal(p.website, 'https://example.com/');
    assert.equal(p.senderEmail, 'me@example.com');
  });

  it('rejects unknown fields and empty patches', () => {
    assert.equal(field(() => parseProfilePatch({ accountId: 'x' })), 'accountId');
    assert.throws(() => parseProfilePatch({}), AppError);
  });
});

describe('anonymous carry-over', () => {
  it('reads {hsCode, hsVersion, countries[]} leniently', () => {
    const c = parseAnonCarryOver({ hsCode: '630221', hsVersion: 'HS2022', countries: ['us', 'bad', 'US', 'de'] });
    assert.deepEqual(c.hs, { code: '630221', level: 'subheading', version: 'HS2022' });
    assert.deepEqual(c.countries, ['US', 'DE']);
    assert.deepEqual(parseAnonCarryOver({ hsCode: 'zz', hsVersion: 'HS2022' }), { hs: null, countries: [] });
    assert.deepEqual(parseAnonCarryOver(null), { hs: null, countries: [] });
  });
});

describe('idempotency', () => {
  it('hashes payloads independently of key order and the key itself', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
    assert.equal(requestHash('r', { a: 1, b: 2, idempotencyKey: 'k1' }), requestHash('r', { b: 2, a: 1 }));
    assert.notEqual(requestHash('r', { a: 1 }), requestHash('r', { a: 2 }));
  });

  it('reads the key from the header or the body', () => {
    assert.equal(idempotencyKeyOf({ 'idempotency-key': 'abc-1' }, {}), 'abc-1');
    assert.equal(idempotencyKeyOf({}, { idempotencyKey: 'form-2' }), 'form-2');
    assert.equal(idempotencyKeyOf({}, {}), null);
    assert.throws(() => idempotencyKeyOf({ 'idempotency-key': 'bad key!' }, {}), AppError);
  });
});

describe('text[] mapping', () => {
  it('accepts arrays and postgres literals', () => {
    assert.deepEqual(textArray(['US']), ['US']);
    assert.deepEqual(textArray('{US,GB}'), ['US', 'GB']);
    assert.deepEqual(textArray('{}'), []);
  });
});
