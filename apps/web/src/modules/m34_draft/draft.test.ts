/**
 * M34 unit tests for pure logic (no database, no LLM): the footer builder (IF-34b), request
 * validation, and evidence-snippet selection/sanitisation for the prompt.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../m01_platform/index.js';
import type { ProfileDoc } from '../m10_policy/index.js';
import { buildFooter, EU_EEA_UK_CH_COUNTRIES } from './footer.js';
import { buildDraftPrompt, pickEvidenceSnippets, sanitizeSnippet } from './prompt.js';
import { parseCreateDraftRequest, parseDraftIdParam, parseHandoffRequest, parsePatchDraftRequest } from './validate.js';

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

describe('buildFooter (IF-34b)', () => {
  const profile = { businessName: 'Acme Exports', senderName: 'Priya Sharma', city: 'Surat', state: 'Gujarat', iec: 'ABCD1234EF' };

  it('includes sender, business, location, IEC and the opt-out line', () => {
    const footer = buildFooter(profile, { country: 'US', evidenceSourceTypes: [] }, 'en');
    assert.match(footer, /Priya Sharma, Acme Exports/);
    assert.match(footer, /Surat, Gujarat/);
    assert.match(footer, /IEC: ABCD1234EF/);
    assert.match(footer, /Reply 'unsubscribe' and I won't contact you again\./);
  });

  it('omits the IEC line when absent', () => {
    const footer = buildFooter({ ...profile, iec: null }, { country: 'US', evidenceSourceTypes: [] }, 'en');
    assert.doesNotMatch(footer, /IEC:/);
  });

  it('adds the source-disclosure line only for EU/EEA/UK/CH buyers', () => {
    const us = buildFooter(profile, { country: 'US', evidenceSourceTypes: ['website'] }, 'en');
    assert.doesNotMatch(us, /I found your company through/);

    const de = buildFooter(profile, { country: 'DE', evidenceSourceTypes: ['website'] }, 'en');
    assert.match(de, /I found your company through your public website\./);

    const gb = buildFooter(profile, { country: 'gb', evidenceSourceTypes: ['website', 'customs'] }, 'en');
    assert.match(gb, /I found your company through your public website and public trade records\./);

    const ch = buildFooter(profile, { country: 'CH', evidenceSourceTypes: [] }, 'en');
    assert.doesNotMatch(ch, /I found your company through/);
  });

  it('EU_EEA_UK_CH_COUNTRIES carries the UK, Switzerland and a sample of EU/EEA states', () => {
    for (const c of ['GB', 'CH', 'DE', 'FR', 'IS', 'LI', 'NO']) assert.ok(EU_EEA_UK_CH_COUNTRIES.has(c), c);
    assert.ok(!EU_EEA_UK_CH_COUNTRIES.has('US'));
    assert.ok(!EU_EEA_UK_CH_COUNTRIES.has('IN'));
  });

  it('joins three or more source labels with a final "and" (Oxford-comma-free)', () => {
    const footer = buildFooter(profile, { country: 'FR', evidenceSourceTypes: ['website', 'customs', 'registry'] }, 'en');
    assert.match(footer, /your public website, public trade records and public company registries\./);
  });
});

describe('parseCreateDraftRequest', () => {
  it('accepts a well-formed request and lower-cases the entryId', () => {
    const out = parseCreateDraftRequest({ entryId: UUID_A.toUpperCase(), language: 'en', tone: 'formal' });
    assert.equal(out.entryId, UUID_A);
    assert.equal(out.language, 'en');
    assert.equal(out.tone, 'formal');
  });

  it('rejects a non-ISO-639-1 language', () => {
    assert.equal(field(() => parseCreateDraftRequest({ entryId: UUID_A, language: 'eng', tone: 'formal' })), 'language');
  });

  it('rejects an unknown tone', () => {
    assert.equal(field(() => parseCreateDraftRequest({ entryId: UUID_A, language: 'en', tone: 'casual' })), 'tone');
  });

  it('rejects a non-uuid entryId', () => {
    assert.equal(field(() => parseCreateDraftRequest({ entryId: 'nope', language: 'en', tone: 'formal' })), 'entryId');
  });
});

describe('parseDraftIdParam / parsePatchDraftRequest / parseHandoffRequest', () => {
  it('parseDraftIdParam lower-cases a uuid', () => {
    assert.equal(parseDraftIdParam(UUID_A.toUpperCase()), UUID_A);
  });

  it('rejects an empty bodyEdited', () => {
    assert.equal(field(() => parsePatchDraftRequest({ bodyEdited: '  ' })), 'bodyEdited');
  });

  it('accepts a non-empty bodyEdited', () => {
    assert.deepEqual(parsePatchDraftRequest({ bodyEdited: 'Hello there' }), { bodyEdited: 'Hello there' });
  });

  it('rejects an unknown handoff channel', () => {
    assert.equal(field(() => parseHandoffRequest({ via: 'sms' })), 'via');
  });

  it('accepts every LLD-listed handoff channel', () => {
    for (const via of ['copy', 'mailto', 'wa']) assert.deepEqual(parseHandoffRequest({ via }), { via });
  });
});

describe('pickEvidenceSnippets / sanitizeSnippet', () => {
  it('redacts an email or phone number that leaks into a snippet', () => {
    assert.equal(sanitizeSnippet('Contact buyer at ops@example.com'), 'Contact buyer at [redacted]');
    assert.equal(sanitizeSnippet('Call +1 415 555 0100 now'), 'Call [redacted] now');
  });

  it('caps at max, skips entries with no usable snippet text', () => {
    const doc = {
      evidence: [
        { assertion_id: 'a1', hs_heading: '8471', snippet: 'Imports data processing machines regularly.', source_type: 'customs' },
        { assertion_id: 'a2', hs_heading: '8471', snippet: null, source_type: 'website' },
        { assertion_id: 'a3', hs_heading: '8471', snippet: '  ', source_type: 'directory' },
        { assertion_id: 'a4', hs_heading: '8471', snippet: 'Lists this product on their public site.', source_type: 'website' },
        { assertion_id: 'a5', hs_heading: '8471', snippet: 'A third snippet.', source_type: 'registry' },
      ],
    } as unknown as ProfileDoc;

    const out = pickEvidenceSnippets(doc, 2);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.sourceType, 'customs');
    assert.equal(out[1]!.sourceType, 'website');
  });

  it('returns an empty array when the doc has no evidence', () => {
    const doc = {} as unknown as ProfileDoc;
    assert.deepEqual(pickEvidenceSnippets(doc, 5), []);
  });
});

describe('buildDraftPrompt', () => {
  it('never includes a footer instruction to sign off, and instructs the target language', () => {
    const { system, user } = buildDraftPrompt({
      tone: 'friendly',
      language: 'hi',
      businessName: 'Acme Exports',
      whatTheyMake: 'Cotton textiles',
      city: 'Surat',
      hsCode: '5208',
      buyerName: 'Global Textiles Ltd',
      buyerCountry: 'DE',
      evidence: [{ snippet: 'Lists cotton fabric imports on their site.', sourceType: 'website', hsHeading: '5208' }],
    });
    assert.match(system, /Hindi/);
    assert.match(system, /signature block/);
    assert.match(user, /Global Textiles Ltd/);
    assert.match(user, /DE/);
    assert.match(user, /Acme Exports/);
  });

  it('falls back to a generic language instruction for an unmapped ISO code', () => {
    const { system } = buildDraftPrompt({
      tone: 'formal',
      language: 'xx',
      businessName: 'Acme',
      whatTheyMake: null,
      city: null,
      hsCode: null,
      buyerName: 'Buyer Co',
      buyerCountry: 'US',
      evidence: [],
    });
    assert.match(system, /ISO 639-1 code "xx"/);
  });
});
