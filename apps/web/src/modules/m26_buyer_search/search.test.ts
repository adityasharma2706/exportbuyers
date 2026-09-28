/**
 * M26 unit tests (node:test) over the pure request-shaping, row-shaping and discovery-trigger
 * logic. `searchBuyers()` itself composes M07/M10/M15/M20, each already unit-tested in its own
 * module, and is instead covered by integration tests over the composed handler.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setBuyerSearchConfig, buyerSearchConfig } from './config.js';
import { countriesNeedingDiscovery } from './discovery.js';
import { isLowConfidence, passesDiscoveryReleaseGate, strongestEvidenceConfidence, toSearchRowDto } from './rows.js';
import {
  parseBuyerSearchInput,
  parseDiscoveryStatusQuery,
  resolveDefaultCountries,
  resolveExplicitCountries,
  resolveExplicitHeadings,
  resolveKeyword,
  toHeading,
} from './validate.js';
import type { CoverageCell } from '../m15_coverage/index.js';
import type { SearchDoc, SearchResultRow } from '../m10_policy/index.js';

function assertAppError(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail('expected to throw');
  } catch (e) {
    assert.equal((e as { code?: string }).code, code);
  }
}

beforeEach(() => {
  setBuyerSearchConfig({
    maxCountries: 10,
    maxHsHeadings: 5,
    maxKeywordLength: 100,
    lowConfidenceThreshold: 0.6,
    discoveryMinCompanies: 10,
    discoveryPollIntervalSec: 5,
    discoveryPollMaxSec: 180,
    discoveryReleasedCountries: new Set(['GB']),
  });
});

// ---- validate.ts --------------------------------------------------------------------------

test('resolveExplicitCountries: empty list is VALIDATION (choose at least one country)', () => {
  assertAppError(() => resolveExplicitCountries([]), 'VALIDATION');
});

test('resolveExplicitCountries: more than 10 is VALIDATION', () => {
  const many = Array.from({ length: 11 }, (_, i) => `A${i}`);
  assertAppError(() => resolveExplicitCountries(many), 'VALIDATION');
});

test('resolveExplicitCountries: normalises case and dedupes', () => {
  assert.deepEqual(resolveExplicitCountries(['gb', 'GB', 'de']), ['GB', 'DE']);
});

test('resolveExplicitCountries: rejects a malformed code', () => {
  assertAppError(() => resolveExplicitCountries(['gbr']), 'VALIDATION');
});

test('resolveDefaultCountries: silently truncates to the cap rather than rejecting', () => {
  const many = ['GB', 'DE', 'NL', 'AE', 'US', 'FR', 'IT', 'ES', 'PT', 'BE', 'SE'];
  const out = resolveDefaultCountries(many);
  assert.equal(out.length, 10);
  assert.deepEqual(out, many.slice(0, 10));
});

test('toHeading: reduces a 6 or 8 digit code to its 4-digit heading', () => {
  assert.equal(toHeading('630260'), '6302');
  assert.equal(toHeading('63026010'), '6302');
  assert.equal(toHeading('6302'), '6302');
});

test('toHeading: rejects a malformed code', () => {
  assertAppError(() => toHeading('63'), 'VALIDATION');
});

test('resolveExplicitHeadings: more than the configured max is VALIDATION', () => {
  assertAppError(() => resolveExplicitHeadings(['0101', '0102', '0103', '0104', '0105', '0106']), 'VALIDATION');
});

test('resolveKeyword: at most 100 characters are accepted', () => {
  assert.equal(resolveKeyword('cotton towels'), 'cotton towels');
  assert.equal(resolveKeyword('  '), undefined);
  assert.equal(resolveKeyword(undefined), undefined);
  assertAppError(() => resolveKeyword('x'.repeat(101)), 'VALIDATION');
});

test('parseBuyerSearchInput: rejects unknown fields (strict schema)', () => {
  assertAppError(() => parseBuyerSearchInput({ notAField: true }), 'VALIDATION');
});

test('parseBuyerSearchInput: accepts an empty body (every field optional)', () => {
  const parsed = parseBuyerSearchInput({});
  assert.deepEqual(parsed, {});
});

test('parseDiscoveryStatusQuery: splits a comma-separated countries query param', () => {
  const { heading, countries } = parseDiscoveryStatusQuery('630260', 'gb,de');
  assert.equal(heading, '6302');
  assert.deepEqual(countries, ['GB', 'DE']);
});

// ---- discovery.ts -------------------------------------------------------------------------

function cell(partial: Partial<CoverageCell> & Pick<CoverageCell, 'country'>): CoverageCell {
  return {
    hsHeading: '6302',
    label: 'limited',
    level: 'heading',
    explanationKey: 'coverage.limited',
    params: { count: 0, sources: [] },
    sourceTypes: [],
    companyCount: 0,
    freshCompanyCount: 0,
    ruleVersion: 1,
    ...partial,
  };
}

test('countriesNeedingDiscovery: under the threshold and not strong → needs discovery', () => {
  const cells = new Map([
    ['GB', cell({ country: 'GB', companyCount: 3, label: 'limited' })],
    ['DE', cell({ country: 'DE', companyCount: 80, label: 'strong' })],
    ['NL', cell({ country: 'NL', companyCount: 9, label: 'partial' })],
    ['AE', cell({ country: 'AE', companyCount: 3, label: 'strong' })],
  ]);
  assert.deepEqual(countriesNeedingDiscovery(cells, 10).sort(), ['GB', 'NL']);
});

// ---- rows.ts ------------------------------------------------------------------------------

function doc(partial: Partial<SearchDoc>): SearchDoc {
  return {
    company_id: 'c1',
    hs_heading: '6302',
    name: 'Acme Textiles',
    city: 'London',
    country: 'GB',
    buyer_type: 'importer',
    buyer_type_confidence: 0.9,
    evidence_summary: [],
    strongest_source_type: null,
    last_activity: null,
    trust_level: 'medium',
    contact_types: [],
    shipments_12m: null,
    volume_kg_12m: null,
    origin_india: 'unknown',
    origin_competitor: 'unknown',
    is_logistics: false,
    sanctions_block: false,
    assertion_ids: [],
    field_sources: {},
    facts: [],
    non_exportable_assertion_ids: [],
    hidden_assertion_ids: [],
    projection_version: 1,
    built_at: new Date().toISOString(),
    ...partial,
  };
}

test('strongestEvidenceConfidence: max confidence among facts backing the evidence summary', () => {
  const d = doc({
    evidence_summary: [
      { assertion_id: 'a1', snippet: 'imports cotton towels', source_type: 'website', checked_at: null },
      { assertion_id: 'a2', snippet: 'buys bath linen', source_type: 'website', checked_at: null },
    ],
    facts: [
      { assertion_id: 'a1', attribute: 'product_evidence', source_id: 'web.crawl', source_type: 'website', observed_at: null, checked_at: null, confidence: 0.4, llm_assisted: true, can_export: true, personal_data_class: 'none', region: null },
      { assertion_id: 'a2', attribute: 'product_evidence', source_id: 'web.crawl', source_type: 'website', observed_at: null, checked_at: null, confidence: 0.7, llm_assisted: true, can_export: true, personal_data_class: 'none', region: null },
    ],
  });
  assert.equal(strongestEvidenceConfidence(d), 0.7);
});

test('strongestEvidenceConfidence: null when there is no matching fact', () => {
  assert.equal(strongestEvidenceConfidence(doc({})), null);
});

test('isLowConfidence: website-only strongest source is always low confidence', () => {
  assert.equal(isLowConfidence(doc({ strongest_source_type: 'website' })), true);
});

test('isLowConfidence: below the threshold is low confidence', () => {
  const d = doc({
    strongest_source_type: 'directory',
    evidence_summary: [{ assertion_id: 'a1', snippet: null, source_type: 'directory', checked_at: null }],
    facts: [{ assertion_id: 'a1', attribute: 'product_evidence', source_id: 'x', source_type: 'directory', observed_at: null, checked_at: null, confidence: 0.5, llm_assisted: false, can_export: true, personal_data_class: 'none', region: null }],
  });
  assert.equal(isLowConfidence(d), true);
});

test('isLowConfidence: customs-only (no web evidence) is not penalised', () => {
  assert.equal(isLowConfidence(doc({ strongest_source_type: 'customs' })), false);
});

test('passesDiscoveryReleaseGate: non-website evidence always passes', () => {
  assert.equal(passesDiscoveryReleaseGate(doc({ strongest_source_type: 'customs', country: 'IN' })), true);
});

test('passesDiscoveryReleaseGate: website-only evidence gated by the released-country list', () => {
  assert.equal(passesDiscoveryReleaseGate(doc({ strongest_source_type: 'website', country: 'GB' })), true);
  assert.equal(passesDiscoveryReleaseGate(doc({ strongest_source_type: 'website', country: 'FR' })), false);
});

test('toSearchRowDto: shapes a full doc row, mapping sanctions warning from the decision', () => {
  const row: SearchResultRow = {
    doc: doc({ contact_types: ['website', 'role_email'] }),
    decision: { visibility: 'visible_with_warning', allowed: ['view'], redactedFields: [], reasons: ['SANCTIONS_BLOCK'] },
  };
  const dto = toSearchRowDto(row);
  assert.equal(dto.companyId, 'c1');
  assert.equal(dto.name, 'Acme Textiles');
  assert.equal(dto.sanctionsWarning, true);
  assert.deepEqual(dto.decision.allowed, ['view']);
  assert.deepEqual(dto.contactTypes, ['website', 'role_email']);
});

test('toSearchRowDto: an anonymous preview row carries only the preview fields', () => {
  const row: SearchResultRow = {
    doc: doc({}),
    decision: { visibility: 'visible', allowed: ['view'], redactedFields: [], reasons: [] },
    preview: { name: 'Acme Textiles', country: 'GB', buyerType: 'importer', trustLevel: 'medium' },
  };
  const dto = toSearchRowDto(row);
  assert.equal(dto.companyId, '');
  assert.equal(dto.name, 'Acme Textiles');
  assert.equal(dto.city, null);
  assert.deepEqual(dto.decision.allowed, ['view']);
  assert.equal(dto.lowConfidence, false);
});

test('buyerSearchConfig(): defaults are sane and overridable for tests', () => {
  assert.equal(buyerSearchConfig().maxCountries, 10);
  setBuyerSearchConfig({ maxCountries: 3 });
  assert.equal(buyerSearchConfig().maxCountries, 3);
});
