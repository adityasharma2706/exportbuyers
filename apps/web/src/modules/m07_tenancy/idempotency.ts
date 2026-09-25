/**
 * M07 — Idempotency-Key handling for mutating endpoints (LLD §0.3 rule 2):
 *   - same key + same payload hash → the stored response is returned;
 *   - same key + different payload → CONFLICT.
 * Keys are per account (serving.tenancy_idempotency, account-scoped). Only successful (2xx)
 * responses are stored, so a failed attempt can be retried with the same key.
 */
import { createHash } from 'node:crypto';
import { AppError, scoped, type ActorContext } from '../m01_platform/index.js';
import { findIdempotent, storeIdempotent } from './repo.js';

const KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export interface StoredResponse {
  status: number;
  body?: unknown;
}

/** Stable JSON: object keys sorted, so key order does not change the hash. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined && k !== 'idempotencyKey')
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function requestHash(route: string, payload: unknown): string {
  return createHash('sha256').update(route).update('\n').update(canonicalJson(payload)).digest('hex');
}

/** Reads the key from the `Idempotency-Key` header or a body field `idempotencyKey`. */
export function idempotencyKeyOf(headers: Record<string, string | string[] | undefined>, body: unknown): string | null {
  const h = headers['idempotency-key'];
  let key: unknown = Array.isArray(h) ? h[0] : h;
  if ((key === undefined || key === '') && body !== null && typeof body === 'object' && !Array.isArray(body)) {
    key = (body as Record<string, unknown>).idempotencyKey;
  }
  if (key === undefined || key === null || key === '') return null;
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new AppError('VALIDATION', 'Idempotency-Key must be 1-200 characters of letters, digits, . _ : -', {
      field: 'idempotencyKey',
    });
  }
  return key;
}

/**
 * Runs `fn` at most once per (account, key). Without a key (or without an account, e.g. an
 * anonymous caller that will be rejected anyway) it simply runs `fn`.
 */
export async function withIdempotency(
  ctx: ActorContext,
  key: string | null,
  route: string,
  payload: unknown,
  fn: () => Promise<StoredResponse>,
): Promise<StoredResponse> {
  if (key === null || !ctx.accountId) return fn();
  const hash = requestHash(route, payload);
  const db = scoped(ctx);
  const prior = await findIdempotent(db, key);
  if (prior) return replay(prior.route, prior.request_hash, prior.status, prior.response, route, hash);

  const out = await fn();
  if (out.status >= 200 && out.status < 300) {
    const stored = await storeIdempotent(db, {
      idem_key: key,
      route,
      request_hash: hash,
      status: out.status,
      response: out.body,
    });
    if (!stored) {
      // A concurrent request with the same key finished first; answer consistently with it.
      const winner = await findIdempotent(db, key);
      if (winner) return replay(winner.route, winner.request_hash, winner.status, winner.response, route, hash);
    }
  }
  return out;
}

function replay(
  priorRoute: string,
  priorHash: string,
  status: number,
  response: unknown,
  route: string,
  hash: string,
): StoredResponse {
  if (priorRoute !== route || priorHash !== hash) {
    throw new AppError('CONFLICT', 'Idempotency-Key was already used with a different request', { field: 'idempotencyKey' });
  }
  return response === null || response === undefined ? { status } : { status, body: response };
}
