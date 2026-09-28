/**
 * M32 — encryption at rest for `serving.check_run.input_enc` (LLD M32 schema note: "The input is
 * stored ... for the user's history"). The stored input is free-text a visitor typed about a third
 * party (name/email/website/country/messageText), so it is encrypted the same way M29 encrypts
 * revealed contact values: AES-256-GCM, a dedicated secret, with the account id and check-run id
 * bound in as AAD. [deviation: same as M29's own crypto.ts — "a KMS data key" in the LLD becomes a
 * single AES-256-GCM secret from the secrets manager here, because standing up a real KMS envelope
 * is an infrastructure integration this module cannot do itself; swapping it in later only touches
 * this file.]
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError, getSecret } from '../m01_platform/index.js';

/** base64 of 32 random bytes; AES-256-GCM key for check_run.input_enc. */
export const SECRET_CHECK_ENC_KEY = 'M32_ENC_KEY';

function encKey(): Buffer {
  const raw = getSecret(SECRET_CHECK_ENC_KEY);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new AppError('INTERNAL', `Secret ${SECRET_CHECK_ENC_KEY} must be base64 of exactly 32 bytes`);
  return key;
}

function aad(accountId: string, checkRunId: string): Buffer {
  return Buffer.from(`m32:${accountId}:${checkRunId}`, 'utf8');
}

/** Output = iv(12) | tag(16) | ciphertext. */
export function encryptInput(plainJson: string, accountId: string, checkRunId: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  c.setAAD(aad(accountId, checkRunId));
  const ct = Buffer.concat([c.update(Buffer.from(plainJson, 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decryptInput(blob: Buffer, accountId: string, checkRunId: string): string {
  if (!Buffer.isBuffer(blob) || blob.length < 29) throw new AppError('INTERNAL', 'Encrypted check-run input is truncated');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAAD(aad(accountId, checkRunId));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) {
    throw new AppError('INTERNAL', 'Encrypted check-run input failed authentication', undefined, { cause: e });
  }
}
