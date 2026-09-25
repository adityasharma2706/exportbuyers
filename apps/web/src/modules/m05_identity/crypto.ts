/**
 * M05 — cryptographic helpers: OTP hashing, session tokens, signed device cookie,
 * secret-at-rest encryption (TOTP secrets, pending OTP destinations) and RFC 6238 TOTP.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError, getSecret } from '../m01_platform/index.js';

// ---- secrets ------------------------------------------------------------------------------

/** HMAC pepper for OTP codes and destination hashes. */
export const SECRET_OTP_PEPPER = 'M05_OTP_PEPPER';
/** HMAC key for the signed first-party device cookie. */
export const SECRET_COOKIE_KEY = 'M05_COOKIE_KEY';
/** base64 of 32 random bytes; AES-256-GCM key for data encrypted at rest by M05. */
export const SECRET_ENC_KEY = 'M05_ENC_KEY';

function secretBytes(name: string, minLen: number): Buffer {
  const v = getSecret(name);
  const buf = Buffer.from(v, 'utf8');
  if (buf.length < minLen) throw new AppError('INTERNAL', `Secret ${name} is too short (need at least ${minLen} bytes)`);
  return buf;
}

function encKey(): Buffer {
  const raw = getSecret(SECRET_ENC_KEY);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new AppError('INTERNAL', `Secret ${SECRET_ENC_KEY} must be base64 of exactly 32 bytes`);
  return key;
}

// ---- hashing ------------------------------------------------------------------------------

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function hmacHex(key: Buffer | string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** LLD: code stored as hmac_sha256(pepper, code). */
export function hashOtpCode(code: string): string {
  return hmacHex(secretBytes(SECRET_OTP_PEPPER, 16), code);
}

/** Destination (phone/email) is never stored in clear in otp_challenge. */
export function hashDestination(channel: 'sms' | 'email', normalised: string): string {
  return hmacHex(secretBytes(SECRET_OTP_PEPPER, 16), `dest:${channel}:${normalised}`);
}

/** Hash used as a rate-limit key for IPs / user agents (so Redis never holds raw identifiers). */
export function keyHash(kind: string, value: string): string {
  return hmacHex(secretBytes(SECRET_OTP_PEPPER, 16), `${kind}:${value}`).slice(0, 32);
}

export function generateOtpCode(digits = 6): string {
  const max = 10 ** digits;
  return String(randomInt(0, max)).padStart(digits, '0');
}

// ---- session tokens -----------------------------------------------------------------------

/** 256-bit random session token (cookie value) and its storage id (sha256 hex). */
export function newSessionToken(): { token: string; id: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, id: sessionIdFromToken(token) };
}

export function sessionIdFromToken(token: string): string {
  return sha256Hex(token);
}

export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

// ---- signed device cookie -----------------------------------------------------------------

/** Device cookie value: `<random id>.<hmac>` */
export function newDeviceCookie(): { deviceId: string; value: string } {
  const deviceId = randomBytes(16).toString('base64url');
  return { deviceId, value: signDeviceId(deviceId) };
}

export function signDeviceId(deviceId: string): string {
  const mac = createHmac('sha256', secretBytes(SECRET_COOKIE_KEY, 16)).update(`did:${deviceId}`).digest('base64url');
  return `${deviceId}.${mac}`;
}

/** Returns the device id when the signature verifies, else null. */
export function verifyDeviceCookie(value: string | undefined): string | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const deviceId = value.slice(0, dot);
  if (!/^[A-Za-z0-9_-]{22}$/.test(deviceId)) return null;
  const expected = Buffer.from(signDeviceId(deviceId));
  const got = Buffer.from(value);
  if (expected.length !== got.length) return null;
  return timingSafeEqual(expected, got) ? deviceId : null;
}

// ---- encryption at rest -------------------------------------------------------------------

/** AES-256-GCM; output = iv(12) | tag(16) | ciphertext. */
export function encrypt(plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decrypt(blob: Buffer, aad: string): Buffer {
  if (blob.length < 29) throw new AppError('INTERNAL', 'Encrypted value is truncated');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]);
  } catch (e) {
    throw new AppError('INTERNAL', 'Encrypted value failed authentication', undefined, { cause: e });
  }
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits) ------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new AppError('VALIDATION', 'Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/**
 * Verifies a TOTP code within ±window steps. Returns the matched time step (for replay
 * protection) or null.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, stepSec = 30, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(nowMs / 1000 / stepSec);
  const want = Buffer.from(code);
  let matched: number | null = null;
  for (let d = -window; d <= window; d += 1) {
    const candidate = Buffer.from(hotp(secret, step + d));
    // Check every candidate (no early exit) to keep timing independent of which step matched.
    if (timingSafeEqual(candidate, want) && matched === null) matched = step + d;
  }
  return matched;
}

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}
