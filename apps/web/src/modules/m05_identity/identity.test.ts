/**
 * M05 unit tests for the logic that needs no database or network: validation, crypto,
 * TOTP, cookies and the sliding-window limiter.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { AppError, setSecretsForTesting } from '../m01_platform/index.js';
import {
  base32Decode,
  base32Encode,
  decrypt,
  encrypt,
  generateOtpCode,
  hashOtpCode,
  hotp,
  newSessionToken,
  isWellFormedToken,
  newDeviceCookie,
  safeEqualHex,
  sessionIdFromToken,
  verifyDeviceCookie,
  verifyTotp,
} from './crypto.js';
import { MemorySlidingWindowStore } from './rateLimit.js';
import { parseCookies } from './session.js';
import { normaliseDestination, parseOtpVerify } from './validate.js';

setSecretsForTesting({
  M05_OTP_PEPPER: 'test-pepper-0123456789abcdef',
  M05_COOKIE_KEY: 'test-cookie-key-0123456789abcdef',
  M05_ENC_KEY: randomBytes(32).toString('base64'),
});

function validationDetails(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'VALIDATION');
    return e.details ?? {};
  }
  assert.fail('expected VALIDATION');
}

describe('destination validation', () => {
  it('accepts and normalises Indian mobiles', () => {
    assert.equal(normaliseDestination('sms', '+91 98123-45678'), '+919812345678');
    assert.equal(normaliseDestination('sms', '0091 9812345678'), '+919812345678');
  });
  it('rejects non-+91 numbers and suggests email', () => {
    assert.equal(validationDetails(() => normaliseDestination('sms', '+14155550123')).suggestChannel, 'email');
    assert.equal(validationDetails(() => normaliseDestination('sms', '9812345678')).suggestChannel, 'email');
    assert.equal(validationDetails(() => normaliseDestination('sms', '+915812345678')).reason, 'invalid_mobile');
  });
  it('lower-cases emails and rejects bad ones', () => {
    assert.equal(normaliseDestination('email', '  Asha@Example.IN '), 'asha@example.in');
    validationDetails(() => normaliseDestination('email', 'not-an-email'));
  });
  it('requires a 6-digit code and uuid challenge id', () => {
    validationDetails(() => parseOtpVerify({ challengeId: 'x', code: '123456' }));
    validationDetails(() => parseOtpVerify({ challengeId: '01890a5d-ac96-774b-bcce-b302099a8057', code: '12345' }));
  });
});

describe('otp and session crypto', () => {
  it('generates 6-digit codes and hashes them with the pepper', () => {
    for (let i = 0; i < 50; i += 1) assert.match(generateOtpCode(), /^\d{6}$/);
    assert.ok(safeEqualHex(hashOtpCode('123456'), hashOtpCode('123456')));
    assert.ok(!safeEqualHex(hashOtpCode('123456'), hashOtpCode('123457')));
  });
  it('stores only sha256 of the 256-bit session token', () => {
    const { token, id } = newSessionToken();
    assert.ok(isWellFormedToken(token));
    assert.equal(id, sessionIdFromToken(token));
    assert.equal(id.length, 64);
    assert.notEqual(id, token);
  });
  it('signs and verifies the device cookie', () => {
    const { deviceId, value } = newDeviceCookie();
    assert.equal(verifyDeviceCookie(value), deviceId);
    assert.equal(verifyDeviceCookie(`${deviceId}.forged`), null);
    assert.equal(verifyDeviceCookie(undefined), null);
  });
  it('encrypts with authenticated additional data', () => {
    const blob = encrypt(Buffer.from('secret'), 'aad-1');
    assert.equal(decrypt(blob, 'aad-1').toString(), 'secret');
    assert.throws(() => decrypt(blob, 'aad-2'));
  });
});

describe('totp', () => {
  const secret = Buffer.from('12345678901234567890');
  it('matches the RFC 6238 SHA-1 vector', () => {
    assert.equal(hotp(secret, 1), '287082');
    assert.equal(verifyTotp(secret, '287082', 59_000), 1);
    assert.equal(verifyTotp(secret, '000000', 59_000), null);
  });
  it('round-trips base32', () => {
    const b = randomBytes(20);
    assert.deepEqual(base32Decode(base32Encode(b)), b);
    assert.equal(base32Encode(Buffer.from('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('cookies', () => {
  it('parses a cookie header', () => {
    assert.deepEqual(parseCookies('sid=abc; did="x.y"; empty=; sid=dup'), { sid: 'abc', did: 'x.y', empty: '' });
  });
});

describe('sliding window limiter', () => {
  it('is all-or-nothing across windows and reports retryAfter', async () => {
    const s = new MemorySlidingWindowStore();
    const dest = { key: 'd', limit: 3, windowSec: 900 };
    const ip = { key: 'i', limit: 10, windowSec: 3600 };
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) assert.ok((await s.hit([dest, ip], t0 + i, true)).allowed);
    const r = await s.hit([dest, ip], t0 + 10, true);
    assert.equal(r.allowed, false);
    assert.equal(r.blockedBy, 0);
    assert.ok(r.retryAfterSec > 0 && r.retryAfterSec <= 900);
    // The refused call did not consume the IP window.
    assert.equal((await s.hit([ip], t0 + 11, false)).counts[0], 3);
    // After the window slides, the destination may request again.
    assert.ok((await s.hit([dest, ip], t0 + 900_001, true)).allowed);
  });
});
