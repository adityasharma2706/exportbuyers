/**
 * M29 — encryption at rest for revealed contact values (LLD M29 schema note: "value_enc bytea,
 * encrypted with a KMS data key"). AES-256-GCM with a dedicated secret, mirroring M05's
 * `encrypt`/`decrypt` (m05_identity/crypto.ts) which is private to that module and not exported,
 * so M29 — the only module allowed to decrypt contact values (LLD DB migration note: "decrypted
 * only by M29's own repo") — carries its own copy rather than reusing M05's.
 *
 * [deviation: the LLD schema comment says "a KMS data key"; a real KMS envelope (data key wrapped
 * by a CMK, rotated) is an infrastructure integration this module cannot stand up itself. This
 * follows M05's existing precedent instead: a single AES-256-GCM secret key from the secrets
 * manager, scoped to one purpose (M29_ENC_KEY), with the account id and assertion id bound in as
 * AAD so a ciphertext cannot be replayed against a different row. Swapping in real KMS envelope
 * encryption later only touches this file.]
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError, getSecret } from '../m01_platform/index.js';

/** base64 of 32 random bytes; AES-256-GCM key for reveal_contact.value_enc. */
export const SECRET_REVEAL_ENC_KEY = 'M29_ENC_KEY';

function encKey(): Buffer {
  const raw = getSecret(SECRET_REVEAL_ENC_KEY);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new AppError('INTERNAL', `Secret ${SECRET_REVEAL_ENC_KEY} must be base64 of exactly 32 bytes`);
  return key;
}

function aad(accountId: string, assertionId: string): Buffer {
  return Buffer.from(`m29:${accountId}:${assertionId}`, 'utf8');
}

/** Output = iv(12) | tag(16) | ciphertext. */
export function encryptValue(plain: string, accountId: string, assertionId: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  c.setAAD(aad(accountId, assertionId));
  const ct = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decryptValue(blob: Buffer, accountId: string, assertionId: string): string {
  if (!Buffer.isBuffer(blob) || blob.length < 29) throw new AppError('INTERNAL', 'Encrypted contact value is truncated');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAAD(aad(accountId, assertionId));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) {
    throw new AppError('INTERNAL', 'Encrypted contact value failed authentication', undefined, { cause: e });
  }
}
