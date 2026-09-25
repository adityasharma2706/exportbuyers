/**
 * M06 unit tests for the pure ledger logic (no database): validation, folding the
 * append-only history, grant de-duplication, the re-accept rule and the EV-11 schema.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, type Id } from '../m01_platform/index.js';
import {
  consentRequired,
  consentWithdrawnSchema,
  foldConsent,
  inetOrNull,
  isConsentRequired,
  isGranted,
  needsWithdraw,
  noticeSha256,
  parseNoticeVersion,
  parsePurposes,
  purposesToGrant,
  reacceptStatus,
} from './ledger.js';
import type { ConsentAction, ConsentEvent, Purpose } from './types.js';

const ACCOUNT = '01900000-0000-7000-8000-000000000001' as Id<'account'>;
let seq = 0;

function ev(purpose: Purpose, action: ConsentAction, at: string, noticeVersion = 'v1'): ConsentEvent {
  seq += 1;
  return {
    id: `01900000-0000-7000-8000-${String(seq).padStart(12, '0')}` as Id<'consent_event'>,
    accountId: ACCOUNT,
    memberId: null,
    purpose,
    action,
    noticeVersion,
    channel: 'web',
    ip: null,
    at: new Date(at),
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError);
    return e.code;
  }
  assert.fail('expected an AppError');
}

describe('validation', () => {
  it('dedupes purposes and rejects unknown ones', () => {
    assert.deepEqual(parsePurposes(['core_service', 'analytics', 'core_service']), ['core_service', 'analytics']);
    assert.equal(codeOf(() => parsePurposes([])), 'VALIDATION');
    assert.equal(codeOf(() => parsePurposes(['sms_spam'])), 'VALIDATION');
    assert.equal(codeOf(() => parsePurposes('core_service')), 'VALIDATION');
  });

  it('checks notice version format', () => {
    assert.equal(parseNoticeVersion('2026-09.1'), '2026-09.1');
    assert.equal(codeOf(() => parseNoticeVersion('../etc')), 'VALIDATION');
    assert.equal(codeOf(() => parseNoticeVersion('')), 'VALIDATION');
  });

  it('keeps only plausible IPs', () => {
    assert.equal(inetOrNull('::ffff:10.0.0.1'), '10.0.0.1');
    assert.equal(inetOrNull('0.0.0.0'), null);
    assert.equal(inetOrNull('not-an-ip'), null);
    assert.equal(inetOrNull(undefined), null);
  });

  it('hashes notice bodies with sha256', () => {
    assert.match(noticeSha256('# Notice'), /^[0-9a-f]{64}$/);
    assert.equal(noticeSha256('a'), noticeSha256('a'));
    assert.notEqual(noticeSha256('a'), noticeSha256('b'));
  });
});

describe('ledger fold', () => {
  it('takes the latest decision per purpose regardless of input order', () => {
    const events = [
      ev('marketing_email', 'withdraw', '2026-03-01T00:00:00Z'),
      ev('core_service', 'grant', '2026-01-01T00:00:00Z'),
      ev('marketing_email', 'grant', '2026-01-01T00:00:00Z'),
    ];
    const s = foldConsent(events);
    assert.equal(isGranted(s, 'core_service'), true);
    assert.equal(isGranted(s, 'marketing_email'), false);
    assert.equal(s.whatsapp, undefined);
    assert.equal(isGranted(s, 'whatsapp'), false);
  });

  it('breaks same-timestamp ties by uuidv7 id order', () => {
    const a = ev('analytics', 'grant', '2026-01-01T00:00:00Z');
    const b = ev('analytics', 'withdraw', '2026-01-01T00:00:00Z');
    assert.equal(isGranted(foldConsent([b, a]), 'analytics'), false);
  });

  it('only appends grants that change state', () => {
    const s = foldConsent([ev('core_service', 'grant', '2026-01-01T00:00:00Z', 'v1')]);
    assert.deepEqual(purposesToGrant(s, ['core_service', 'analytics'], 'v1'), ['analytics']);
    assert.deepEqual(purposesToGrant(s, ['core_service'], 'v2'), ['core_service']);
  });

  it('withdraws only what is granted', () => {
    const s = foldConsent([ev('whatsapp', 'grant', '2026-01-01T00:00:00Z'), ev('whatsapp', 'withdraw', '2026-02-01T00:00:00Z')]);
    assert.equal(needsWithdraw(s, 'whatsapp'), false);
    assert.equal(needsWithdraw(s, 'analytics'), false);
  });
});

describe('re-accept rule', () => {
  it('requires core_service against a current notice', () => {
    assert.equal(reacceptStatus({}, 'v2', ['v2']).required, true);
    const s = foldConsent([ev('core_service', 'grant', '2026-01-01T00:00:00Z', 'v1')]);
    assert.deepEqual(reacceptStatus(s, 'v2', ['v2', 'hi-v2']), { required: true, currentVersion: 'v2', acceptedVersion: 'v1' });
    assert.equal(reacceptStatus(s, 'v1', ['v1']).required, false);
    // A grant against the current notice of another locale also counts.
    const hi = foldConsent([ev('core_service', 'grant', '2026-01-01T00:00:00Z', 'hi-v2')]);
    assert.equal(reacceptStatus(hi, 'v2', ['v2', 'hi-v2']).required, false);
  });

  it('treats a withdrawn core_service as needing consent', () => {
    const s = foldConsent([
      ev('core_service', 'grant', '2026-01-01T00:00:00Z', 'v1'),
      ev('core_service', 'withdraw', '2026-02-01T00:00:00Z', 'v1'),
    ]);
    assert.equal(reacceptStatus(s, 'v1', ['v1']).required, true);
  });

  it('builds CONSENT_REQUIRED as a CONFLICT sub-code', () => {
    const e = consentRequired('x', { currentVersion: 'v2' });
    assert.equal(e.code, 'CONFLICT');
    assert.equal(e.http, 409);
    assert.equal(e.details?.subCode, 'CONSENT_REQUIRED');
    assert.equal(isConsentRequired(e), true);
    assert.equal(isConsentRequired(new AppError('CONFLICT', 'other')), false);
  });
});

describe('EV-11 schema', () => {
  it('accepts a well-formed payload and rejects others', () => {
    assert.equal(consentWithdrawnSchema.safeParse({ v: 1, accountId: ACCOUNT, purpose: 'whatsapp' }).success, true);
    assert.equal(consentWithdrawnSchema.safeParse({ v: 1, accountId: 'nope', purpose: 'whatsapp' }).success, false);
    assert.equal(consentWithdrawnSchema.safeParse({ v: 1, accountId: ACCOUNT, purpose: 'sms' }).success, false);
    assert.equal(consentWithdrawnSchema.safeParse(null).success, false);
  });
});
