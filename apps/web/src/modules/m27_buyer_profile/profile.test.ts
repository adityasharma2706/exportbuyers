/**
 * M27 unit tests (node:test) over the pure doc-shaping (`dto.ts`), the provider extension points
 * (`providers.ts`) and the label mapping (`labels.ts`). `getBuyerProfile()` itself composes M10's
 * `byIds` (DB-backed) and is instead covered by integration tests over the composed handler, as
 * with M26's `searchBuyers()`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { PolicyDecision, ProfileDoc } from '../m10_policy/index.js';
import { toProfileDto } from './dto.js';
import { actionBlockedLabel, BUYER_PROFILE_MESSAGES_EN, fillLabel, resolveBuyerProfileLabels } from './labels.js';
import {
  evaluateRedFlags,
  isRevealed,
  registerProvider,
  resetProvidersForTesting,
  shortlistEntryFor,
} from './providers.js';

function baseDoc(overrides: Partial<ProfileDoc> = {}): ProfileDoc {
  return {
    company_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    status: 'active',
    name: 'Acme Textiles Ltd',
    country: 'US',
    city: 'Los Angeles',
    website: 'acmetextiles.example',
    buyer_type: { type: 'importer', confidence: 0.82, source_type: 'customs', assertion_id: 'a1', checked_at: '2026-01-01T00:00:00Z' },
    hs_headings: ['6302'],
    evidence: [
      {
        assertion_id: 'e1',
        hs_heading: '6302',
        snippet: 'Imported bed linen from India',
        url: null,
        source_type: 'customs',
        observed_at: '2025-12-01T00:00:00Z',
        checked_at: '2025-12-01T00:00:00Z',
        confidence: 0.9,
        llm_assisted: false,
      },
    ],
    activity: [
      {
        assertion_id: 'act1',
        hs_heading: '6302',
        shipments_12m: 12,
        volume_kg_12m: 5000,
        last_seen: '2025-12-01',
        origins: { IN: 8, CN: 4 },
        source_type: 'customs',
        checked_at: '2025-12-02T00:00:00Z',
      },
    ],
    sourcing: { '6302': { origin_india: 'yes', origin_competitor: 'yes' } },
    trust: {
      level: 'medium',
      rollup_assertion_id: 'r1',
      checks: [
        { id: 'registered_entity', outcome: 'pass', explanation_key: 'trust.check.registered_entity.pass', assertion_id: 'c1', source_type: 'registry', checked_at: '2026-01-01T00:00:00Z' },
        { id: 'sanctions', outcome: 'unknown', explanation_key: 'trust.check.sanctions.unknown', assertion_id: 'c2', source_type: 'sanctions', checked_at: '2026-01-01T00:00:00Z' },
      ],
    },
    contacts: [{ assertion_id: 'ct1', kind: 'email', source_type: 'website', checked_at: '2026-01-01T00:00:00Z', deliverability: 'unknown' }],
    contact_types: ['email'],
    signals: {},
    is_logistics: false,
    sanctions_block: false,
    not_buyer_for: [],
    facts: [],
    field_sources: {},
    hidden_assertion_ids: [],
    non_exportable_assertion_ids: [],
    projection_version: 1,
    built_at: '2026-01-05T00:00:00Z',
    ...overrides,
  } as ProfileDoc;
}

function visibleDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return { visibility: 'visible', allowed: ['view', 'reveal', 'draft', 'export', 'notify'], redactedFields: [], reasons: [], ...overrides };
}

// ---- dto.ts -------------------------------------------------------------------------------------

test('toProfileDto: maps evidence, activity, sourcing, trust and contacts from the projected doc', () => {
  const dto = toProfileDto(baseDoc(), visibleDecision());
  assert.equal(dto.name, 'Acme Textiles Ltd');
  assert.equal(dto.evidence.length, 1);
  assert.equal(dto.evidence[0]?.sourceType, 'customs');
  assert.equal(dto.activity.length, 1);
  assert.equal(dto.activity[0]?.shipments12m, 12);
  assert.deepEqual(dto.activity[0]?.origins, { IN: 8, CN: 4 });
  assert.equal(dto.sourcing['6302']?.originIndia, 'yes');
  assert.equal(dto.trust.level, 'medium');
  assert.equal(dto.trust.checks.length, 2);
  assert.equal(dto.trust.checks[0]?.explanationKey, 'trust.check.registered_entity.pass');
  assert.equal(dto.contacts.length, 1);
  assert.equal(dto.contacts[0]?.kind, 'email');
  assert.deepEqual(dto.contactTypes, ['email']);
});

test('toProfileDto: a heading absent from sourcing is "unknown", not "no" (REQ-022)', () => {
  const doc = baseDoc({ hs_headings: ['6302', '6306'], sourcing: { '6302': { origin_india: 'no', origin_competitor: 'no' } } });
  const dto = toProfileDto(doc, visibleDecision());
  assert.equal(dto.sourcing['6302']?.originIndia, 'no');
  assert.equal(dto.sourcing['6306'], undefined);
});

test('toProfileDto: sanctionsWarning reflects the decision, not the raw doc flag', () => {
  const doc = baseDoc({ sanctions_block: true });
  const decision = visibleDecision({ visibility: 'visible_with_warning', allowed: ['view'], reasons: ['SANCTIONS_BLOCK'] });
  const dto = toProfileDto(doc, decision);
  assert.equal(dto.sanctionsWarning, true);
  assert.equal(dto.actions.reveal.allowed, false);
  assert.equal(dto.actions.reveal.explanationKey, 'buyerProfile.action.blocked.sanctions');
  assert.equal(dto.actions.draft.allowed, false);
  assert.equal(dto.actions.draft.explanationKey, 'buyerProfile.action.blocked.sanctions');
});

test('toProfileDto: sanctions reason wins over an incidental plan limit for the explanation key', () => {
  const decision = visibleDecision({ visibility: 'visible_with_warning', allowed: ['view'], reasons: ['PLAN_LIMIT', 'SANCTIONS_BLOCK'] });
  const dto = toProfileDto(baseDoc(), decision);
  assert.equal(dto.actions.reveal.explanationKey, 'buyerProfile.action.blocked.sanctions');
});

test('toProfileDto: an allowed action carries no explanationKey', () => {
  const dto = toProfileDto(baseDoc(), visibleDecision());
  assert.equal(dto.actions.reveal.allowed, true);
  assert.equal(dto.actions.reveal.explanationKey, undefined);
});

test('toProfileDto: malformed nested doc fields degrade to safe defaults instead of throwing', () => {
  const doc = baseDoc({ buyer_type: null, trust: undefined as unknown as ProfileDoc['trust'], evidence: undefined as unknown as ProfileDoc['evidence'] });
  const dto = toProfileDto(doc, visibleDecision());
  assert.equal(dto.buyerType, null);
  assert.equal(dto.trust.level, 'unknown');
  assert.deepEqual(dto.evidence, []);
});

// ---- providers.ts --------------------------------------------------------------------------------

beforeEach(() => {
  resetProvidersForTesting();
});

test('evaluateRedFlags: empty when no M32 provider is registered', async () => {
  const flags = await evaluateRedFlags({} as never, baseDoc());
  assert.deepEqual(flags, []);
});

test('evaluateRedFlags: uses the registered provider and tolerates a throw', async () => {
  registerProvider('redFlags', {
    evaluateContextual: () => [{ id: 'advance_fee', severity: 'high', explanationKey: 'checkBuyer.flag.advanceFee' }],
  });
  const flags = await evaluateRedFlags({} as never, baseDoc());
  assert.equal(flags.length, 1);
  assert.equal(flags[0]?.id, 'advance_fee');

  registerProvider('redFlags', {
    evaluateContextual: () => {
      throw new Error('boom');
    },
  });
  const afterThrow = await evaluateRedFlags({} as never, baseDoc());
  assert.deepEqual(afterThrow, []);
});

test('isRevealed: false when no M29 provider is registered', async () => {
  assert.equal(await isRevealed({} as never, 'company-1'), false);
});

test('isRevealed: reflects the registered provider', async () => {
  registerProvider('revealed', { isRevealed: () => true });
  assert.equal(await isRevealed({} as never, 'company-1'), true);
});

test('shortlistEntryFor: undefined without a workspace id or provider', async () => {
  assert.equal(await shortlistEntryFor({} as never, null, 'company-1'), undefined);
  registerProvider('shortlist', { entryFor: () => ({ status: 'contacted', notesCount: 2, draftsCount: 1 }) });
  assert.equal(await shortlistEntryFor({} as never, null, 'company-1'), undefined);
});

test('shortlistEntryFor: the registered entry when a workspace id is present', async () => {
  registerProvider('shortlist', { entryFor: () => ({ status: 'contacted', notesCount: 2, draftsCount: 1 }) });
  const entry = await shortlistEntryFor({} as never, 'ws-1', 'company-1');
  assert.deepEqual(entry, { status: 'contacted', notesCount: 2, draftsCount: 1 });
});

// ---- labels.ts ------------------------------------------------------------------------------------

test('fillLabel: substitutes known variables and leaves unknown ones untouched', () => {
  assert.equal(fillLabel('{count} buyers, {other}', { count: 3 }), '3 buyers, {other}');
});

test('resolveBuyerProfileLabels: falls back to English when no catalogue is given', () => {
  const labels = resolveBuyerProfileLabels(null);
  assert.equal(labels.contactsHeading, BUYER_PROFILE_MESSAGES_EN.contactsHeading);
});

test('actionBlockedLabel: maps known keys and falls back to "other" for anything else', () => {
  const labels = resolveBuyerProfileLabels(null);
  assert.equal(actionBlockedLabel(labels, 'buyerProfile.action.blocked.sanctions'), labels.actionBlockedSanctions);
  assert.equal(actionBlockedLabel(labels, 'buyerProfile.action.blocked.closed'), labels.actionBlockedClosed);
  assert.equal(actionBlockedLabel(labels, undefined), labels.actionBlockedOther);
  assert.equal(actionBlockedLabel(labels, 'not.a.real.key'), labels.actionBlockedOther);
});
