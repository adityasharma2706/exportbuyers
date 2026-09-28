/**
 * M31 — the email-verification token (LLD M31: "a verification email with a 24 h token").
 *
 * The raw token is sent by email and never stored; only its sha256 hex digest is written to
 * `serving.public_removal_challenge.token_hash`, so a database read alone cannot forge a link
 * (same reasoning as M05's OTP/session tokens).
 */
import { randomBytes, createHash } from 'node:crypto';

const TOKEN_BYTES = 32;

/** A URL-safe, unguessable token (256 bits of entropy). */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** sha256 hex digest, used both for the token hash and for `filedBy.ref` (a hashed email — LLD
 * M11 types.ts: "a hashed email for public forms"). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
