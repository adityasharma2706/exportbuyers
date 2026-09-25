/**
 * M10 acceptance tests (LLD M10 Tests):
 *   - the shared normalisation vectors pass (Python runs the same file)
 *   - each rule has its own unit test
 *   - sanctions: `view` allowed, `reveal` / `draft` denied
 *   - anonymous redaction
 *   - after suppress(), the next search() excludes the company before any rebuild runs
 *     (database-backed; runs when TEST_DATABASE_URL points at a migrated Postgres 16)
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { sql } from 'kysely';
import { AppError, closeDb, initDb, loadConfig, newId, systemDb, type ActorContext, type Entitlements } from '../m01_platform/index.js';
import type { SourceEntry } from '../m08_sources/index.js';
import { normalise, normHash } from './normalise.js';
import { parsePsl, registrableDomain } from './psl.js';
import { anonymousSearchDoc, redactProfileDoc } from './redact.js';
import {
  DecisionBuilder,
  evaluate,
  permits,
  ruleLicence,
  ruleLogistics,
  rulePlan,
  ruleRegion,
  ruleSanctions,
  ruleSuppression,
  ruleUserHides,
  type RuleInput,
} from './rules.js';
import type { DocFact, IdentifierKind, ProfileDoc, SearchDoc, SearchQuery } from './types.js';

// ---------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------

const GROWTH: Entitlements = {
  plan: 'growth',
  searchResultCap: 500,
  exportRowsPerMonth: 5000,
  bulkRevealMax: 50,
  checksPerMonth: 100,
  revealsIncludedPerMonth: 50,
};
const FREE: Entitlements = { ...GROWTH, plan: 'free', searchResultCap: 20, exportRowsPerMonth: 0 };

function fact(id: string, over: Partial<DocFact> = {}): DocFact {
  return {
    assertion_id: id,
    attribute: 'contact.phone',
    source_id: 'web_crawl',
    source_type: 'website',
    observed_at: null,
    checked_at: null,
    confidence: 0.8,
    llm_assisted: false,
    can_export: true,
    personal_data_class: 'business_contact',
    region: null,
    ...over,
  };
}

function source(id: string, over: Partial<SourceEntry> = {}): SourceEntry {
  return {
    id,
    sourceType: 'website',
    canStore: true,
    canDisplay: true,
    canExport: true,
    retentionDays: null,
    attributionText: id,
    personalDataClass: 'business_contact',
    allowedRegions: ['*'],
    status: 'active',
    notes: null,
    updatedAt: null,
    ...over,
  };
}

function input(over: Partial<RuleInput> = {}): RuleInput {
  return {
    surface: 'profile',
    anonymous: false,
    entitlements: GROWTH,
    suppressed: false,
    sanctionsBlock: false,
    closed: false,
    fieldSources: { 'contacts.phone': ['a1'], buyer_type: ['a2'] },
    facts: new Map([
      ['a1', fact('a1')],
      ['a2', fact('a2', { attribute: 'buyer_type', personal_data_class: 'none' })],
    ]),
    nonExportableAssertionIds: new Set(),
    sources: new Map([['web_crawl', source('web_crawl')]]),
    region: 'IN',
    isLogistics: false,
    includeLogistics: false,
    userHidden: false,
    hiddenAssertionIds: new Set(),
    ...over,
  };
}

function ctx(over: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: 'system',
    entitlements: GROWTH,
    locale: 'en',
    region: 'IN',
    mfaVerified: false,
    correlationId: 'test-m10',
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// normalisation vectors
// ---------------------------------------------------------------------------------------------

function findSpecFile(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '..', '..', '..', '..', '..', rel)];
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, rel));
    const p = dirname(dir);
    if (p === dir) break;
    dir = p;
  }
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) throw new Error(`spec file ${rel} not found`);
  return hit;
}

interface Vector {
  kind: IdentifierKind;
  raw: string;
  normalised?: string;
  error?: string;
}

describe('normalisation (shared vectors)', () => {
  const file = JSON.parse(readFileSync(findSpecFile(join('spec', 'normalisation', 'vectors.json')), 'utf8')) as { vectors: Vector[] };

  test('at least 40 vectors', () => {
    assert.ok(file.vectors.length >= 40, `only ${file.vectors.length} vectors`);
  });

  for (const v of file.vectors) {
    test(`${v.kind}: ${JSON.stringify(v.raw)}`, () => {
      if (v.error) {
        assert.throws(() => normalise(v.kind, v.raw), (e: unknown) => e instanceof AppError && e.code === v.error);
        return;
      }
      assert.equal(normalise(v.kind, v.raw), v.normalised);
      const expected = createHash('sha256').update(`${v.kind}:${v.normalised}`, 'utf8').digest('hex');
      assert.equal(normHash(v.kind, v.raw), expected);
      assert.match(expected, /^[0-9a-f]{64}$/);
    });
  }

  test('PSL: exception and wildcard rules', () => {
    const rules = parsePsl('uk\nco.uk\n*.ck\n!www.ck\n');
    assert.equal(registrableDomain(rules, 'a.b.example.co.uk'), 'example.co.uk');
    assert.equal(registrableDomain(rules, 'shop.foo.ck'), 'shop.foo.ck');
    assert.equal(registrableDomain(rules, 'a.www.ck'), 'www.ck');
    assert.equal(registrableDomain(rules, 'x.y.example.com'), 'example.com');
  });
});

// ---------------------------------------------------------------------------------------------
// rules, one at a time
// ---------------------------------------------------------------------------------------------

describe('rule 1: global suppression', () => {
  test('suppressed → hidden with SUPPRESSED, nothing allowed', () => {
    const d = ruleSuppression({ suppressed: true });
    assert.deepEqual(d, { visibility: 'hidden', allowed: [], redactedFields: [], reasons: ['SUPPRESSED'] });
    assert.equal(ruleSuppression({ suppressed: false }), null);
  });
  test('suppression wins over every other rule', () => {
    const d = evaluate(input({ suppressed: true, sanctionsBlock: true, includeLogistics: true }));
    assert.deepEqual(d.reasons, ['SUPPRESSED']);
  });
});

describe('rule 2: sanctions', () => {
  test('visible with warning; view allowed, reveal and draft denied', () => {
    const b = new DecisionBuilder();
    ruleSanctions(b, { sanctionsBlock: true });
    const d = b.build();
    assert.equal(d.visibility, 'visible_with_warning');
    assert.deepEqual(d.allowed, ['view']);
    assert.ok(d.reasons.includes('SANCTIONS_BLOCK'));
    const full = evaluate(input({ sanctionsBlock: true }));
    assert.ok(permits(full, 'view'));
    assert.ok(!permits(full, 'reveal'));
    assert.ok(!permits(full, 'draft'));
    assert.ok(!permits(full, 'export'));
  });
});

describe('rule 3: licence', () => {
  test('export redacts fields backed by can_export=false assertions', () => {
    const b = new DecisionBuilder();
    ruleLicence(b, { ...input({ surface: 'export' }), nonExportableAssertionIds: new Set(['a1']) });
    const d = b.build();
    assert.deepEqual(d.redactedFields, ['contacts.phone']);
    assert.deepEqual(d.reasons, ['LICENCE_REDACTED']);
  });
  test('non-export surfaces keep exportable-only restrictions out', () => {
    const b = new DecisionBuilder();
    ruleLicence(b, { ...input({ surface: 'profile' }), nonExportableAssertionIds: new Set(['a1']) });
    assert.deepEqual(b.build().redactedFields, []);
  });
  test('a prohibited source is redacted on every surface', () => {
    const b = new DecisionBuilder();
    ruleLicence(b, input({ sources: new Map([['web_crawl', source('web_crawl', { status: 'prohibited' })]]) }));
    assert.deepEqual(b.build().redactedFields, ['buyer_type', 'contacts.phone']);
  });
});

describe('rule 4: region and personal data', () => {
  test('named_person is always redacted', () => {
    const b = new DecisionBuilder();
    ruleRegion(b, input({ facts: new Map([['a1', fact('a1', { personal_data_class: 'named_person' })]]) }));
    assert.deepEqual(b.build().redactedFields, ['contacts.phone']);
    assert.deepEqual(b.build().reasons, ['REGION_REDACTED']);
  });
  test('source not allowed in the actor region → redacted', () => {
    const sources = new Map([['web_crawl', source('web_crawl', { allowedRegions: ['US'] })]]);
    const b = new DecisionBuilder();
    ruleRegion(b, input({ sources, region: 'IN' }));
    assert.deepEqual(b.build().redactedFields, ['buyer_type', 'contacts.phone']);
    const ok = new DecisionBuilder();
    ruleRegion(ok, input({ sources, region: 'US' }));
    assert.deepEqual(ok.build().redactedFields, []);
  });
  test('unregistered source fails closed', () => {
    const b = new DecisionBuilder();
    ruleRegion(b, input({ sources: new Map([['web_crawl', null]]) }));
    assert.equal(b.build().redactedFields.length, 2);
  });
});

describe('rule 5: logistics default hide (REQ-020)', () => {
  test('hidden by default, visible with the toggle', () => {
    assert.deepEqual(ruleLogistics({ isLogistics: true, includeLogistics: false })?.reasons, ['LOGISTICS_DEFAULT_HIDDEN']);
    assert.equal(ruleLogistics({ isLogistics: true, includeLogistics: true }), null);
    assert.equal(evaluate(input({ isLogistics: true, includeLogistics: true })).visibility, 'visible');
  });
});

describe('rule 6: per-user hides (REQ-025)', () => {
  test('a hidden company is hidden', () => {
    assert.deepEqual(ruleUserHides(null, { ...input(), userHidden: true })?.reasons, ['USER_HIDDEN']);
  });
  test('a hidden assertion redacts its field', () => {
    const b = new DecisionBuilder();
    assert.equal(ruleUserHides(b, { ...input(), hiddenAssertionIds: new Set(['a2']) }), null);
    assert.deepEqual(b.build().redactedFields, ['buyer_type']);
  });
});

describe('rule 7: plan entitlements (REQ-051)', () => {
  test('anonymous may only view and sees only the preview fields on search', () => {
    const b = new DecisionBuilder();
    rulePlan(b, { anonymous: true, entitlements: GROWTH, surface: 'search', fieldSources: { 'contacts.phone': ['a1'], 'trust.level': ['t'] } });
    const d = b.build();
    assert.deepEqual(d.allowed, ['view']);
    assert.deepEqual(d.redactedFields, ['contacts.phone']);
    assert.ok(d.reasons.includes('PLAN_LIMIT'));
  });
  test('a plan without export rows cannot export', () => {
    const d = evaluate(input({ entitlements: FREE }));
    assert.ok(!d.allowed.includes('export'));
    assert.ok(d.allowed.includes('reveal'));
    assert.ok(d.reasons.includes('PLAN_LIMIT'));
  });
});

// ---------------------------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------------------------

function searchDoc(over: Partial<SearchDoc> = {}): SearchDoc {
  return {
    company_id: '0190a3c2-7b1e-7c3d-9f00-0123456789ab',
    hs_heading: '6302',
    name: 'Acme Textiles GmbH',
    city: 'Berlin',
    country: 'DE',
    buyer_type: 'importer',
    buyer_type_confidence: 0.9,
    evidence_summary: [{ assertion_id: 'e1', snippet: 'bed linen', source_type: 'website', checked_at: null }],
    strongest_source_type: 'customs',
    last_activity: '2026-08-01',
    trust_level: 'high',
    contact_types: ['phone', 'role_email'],
    shipments_12m: 12,
    volume_kg_12m: 30000,
    origin_india: 'yes',
    origin_competitor: 'no',
    is_logistics: false,
    sanctions_block: false,
    assertion_ids: ['e1'],
    field_sources: { 'evidence.6302': ['e1'] },
    facts: [fact('e1', { attribute: 'product_evidence' })],
    non_exportable_assertion_ids: [],
    hidden_assertion_ids: [],
    projection_version: 1,
    built_at: '2026-09-01T00:00:00Z',
    ...over,
  };
}

describe('anonymous redaction', () => {
  test('rows carry only name, country, buyer type and trust level', () => {
    const { doc, preview } = anonymousSearchDoc(searchDoc());
    assert.deepEqual(preview, { name: 'Acme Textiles GmbH', country: 'DE', buyerType: 'importer', trustLevel: 'high' });
    assert.equal(doc.company_id, '');
    assert.equal(doc.city, null);
    assert.deepEqual(doc.evidence_summary, []);
    assert.deepEqual(doc.contact_types, []);
    assert.equal(doc.shipments_12m, null);
    assert.deepEqual(doc.facts, []);
  });
});

describe('profile redaction', () => {
  test('redacted contact slots and facts are removed', () => {
    const doc = {
      company_id: 'c', status: 'active', name: 'X', country: 'DE', city: null, website: null, buyer_type: null,
      hs_headings: [], evidence: [], activity: [], sourcing: {}, trust: { level: 'high', rollup_assertion_id: null, checks: [] },
      contacts: [
        { assertion_id: 'a1', kind: 'phone', source_type: 'website', checked_at: null, deliverability: 'valid' },
        { assertion_id: 'a3', kind: 'role_email', source_type: 'website', checked_at: null, deliverability: 'valid' },
      ],
      contact_types: ['phone', 'role_email'], signals: {}, is_logistics: false, sanctions_block: false, not_buyer_for: [],
      facts: [fact('a1'), fact('a3', { attribute: 'contact.role_email' })],
      field_sources: { 'contacts.phone': ['a1'], 'contacts.role_email': ['a3'] },
      hidden_assertion_ids: [], non_exportable_assertion_ids: [], projection_version: 1, built_at: 'x',
    } as ProfileDoc;
    const out = redactProfileDoc(doc, { visibility: 'visible', allowed: ['view'], redactedFields: ['contacts.phone'], reasons: ['LICENCE_REDACTED'] });
    assert.deepEqual(out.contacts.map((c) => c.assertion_id), ['a3']);
    assert.deepEqual(out.facts.map((f) => f.assertion_id), ['a3']);
    assert.deepEqual(out.contact_types, ['role_email']);
    assert.equal(doc.contacts.length, 2, 'input is not mutated');
  });
});

// ---------------------------------------------------------------------------------------------
// database-backed: suppress() → search() excludes before the rebuild
// ---------------------------------------------------------------------------------------------

const DB_URL = process.env.TEST_DATABASE_URL;

describe('suppress then search (database)', { skip: !DB_URL }, () => {
  const companyId = newId<'company'>();
  const q: SearchQuery = { hsHeadings: ['6302'], countries: ['DE'], sort: 'relevance', page: 1, pageSize: 20 };

  before(async () => {
    initDb(loadConfig(), { connectionString: DB_URL! });
    const db = systemDb('m10 test seed');
    await sql`insert into knowledge.company (id, display_name, country) values (${companyId}::uuid, 'Suppress Me GmbH', 'DE')`.execute(db);
    const doc = searchDoc({ company_id: companyId, name: 'Suppress Me GmbH', facts: [], field_sources: {} });
    await sql`
      insert into knowledge.search_doc (company_id, hs_heading, doc, tsv, country, trust_level, identifier_hashes, projection_version, built_at)
      values (${companyId}::uuid, '6302', ${JSON.stringify(doc)}::jsonb, to_tsvector('simple', 'Suppress Me GmbH'), 'DE', 'high',
              ${[normHash('company_id', companyId)]}::text[], 1, now())`.execute(db);
  });

  after(async () => {
    const db = systemDb('m10 test cleanup');
    await sql`delete from knowledge.search_doc where company_id = ${companyId}::uuid`.execute(db);
    await sql`delete from knowledge.suppression where hash = ${normHash('company_id', companyId)}`.execute(db);
    await sql`delete from knowledge.company where id = ${companyId}::uuid`.execute(db);
    await closeDb();
  });

  test('the company disappears from the very next search', async () => {
    const { search, suppress } = await import('./index.js');
    const before1 = await search(ctx(), 'search', q);
    assert.ok(before1.rows.some((r) => r.doc.company_id === companyId));
    await systemDb('m10 test suppress')
      .transaction()
      .execute(async (tx) => suppress(tx, [{ kind: 'company_id', raw: companyId }], 'operator'));
    const after1 = await search(ctx(), 'search', q);
    assert.ok(!after1.rows.some((r) => r.doc.company_id === companyId));
  });
});
