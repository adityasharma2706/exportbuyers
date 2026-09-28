/**
 * M31 — persistence for `serving.public_removal_challenge` (db/migrations/0031_m31_public_removal.sql).
 *
 * The table is global (no account_id), so every function here takes a plain `Db`/`Tx` handle —
 * either `systemDb(reason)` on the request path (no actor is signed in) or the caller's `Tx`
 * inside the transaction that files the M11 review item.
 */
import { sql } from 'kysely';
import type { Db } from '../m01_platform/index.js';
import type { Tx } from '../m02_queue/index.js';
import type { IdentityCheck, NormalisedIdentifiers, RemovalChallengeRow, RemovalKind } from './types.js';

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

function identifiersOf(v: unknown): NormalisedIdentifiers {
  const parsed = parseJson(v);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as NormalisedIdentifiers) : {};
}

interface Row {
  id: string;
  kind: RemovalKind;
  requester_email: string;
  identifiers: unknown;
  matched_company_id: string | null;
  identity_check: IdentityCheck;
  details: string | null;
  token_hash: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  review_item_id: string | null;
  created_at: Date | string;
}

function mapRow(r: Row): RemovalChallengeRow {
  return {
    id: r.id,
    kind: r.kind,
    requesterEmail: r.requester_email,
    identifiers: identifiersOf(r.identifiers),
    matchedCompanyId: r.matched_company_id,
    identityCheck: r.identity_check,
    details: r.details,
    tokenHash: r.token_hash,
    expiresAt: toDate(r.expires_at),
    consumedAt: r.consumed_at === null ? null : toDate(r.consumed_at),
    reviewItemId: r.review_item_id,
    createdAt: toDate(r.created_at),
  };
}

export interface InsertChallengeInput {
  id: string;
  kind: RemovalKind;
  requesterEmail: string;
  identifiers: NormalisedIdentifiers;
  matchedCompanyId: string | null;
  identityCheck: IdentityCheck;
  details: string | null;
  tokenHash: string;
  expiresAt: Date;
}

export async function insertChallenge(db: Db, c: InsertChallengeInput): Promise<void> {
  await sql`
    insert into serving.public_removal_challenge
      (id, kind, requester_email, identifiers, matched_company_id, identity_check, details, token_hash, expires_at, created_at)
    values
      (${c.id}, ${c.kind}, ${c.requesterEmail}, ${JSON.stringify(c.identifiers)}::jsonb, ${c.matchedCompanyId},
       ${c.identityCheck}, ${c.details}, ${c.tokenHash}, ${c.expiresAt}, now())
  `.execute(db);
}

/** Looks up a challenge by its token's sha256 hash. Does not filter by expiry/consumed state;
 * the caller decides what an expired or already-consumed row means (LLD: an already-used link
 * should say so, not "not found"). */
export async function findChallengeByTokenHash(db: Db, tokenHash: string): Promise<RemovalChallengeRow | null> {
  const res = await sql<Row>`
    select * from serving.public_removal_challenge where token_hash = ${tokenHash} limit 1
  `.execute(db);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Marks the challenge consumed and records the filed review item, but only if it is still
 * unconsumed (defends against a race between two concurrent verify calls for the same token).
 * Returns whether this call was the one that consumed it. */
export async function consumeChallenge(tx: Tx, id: string, reviewItemId: string): Promise<boolean> {
  const res = await sql<{ id: string }>`
    update serving.public_removal_challenge
    set consumed_at = now(), review_item_id = ${reviewItemId}
    where id = ${id} and consumed_at is null
    returning id
  `.execute(tx);
  return res.rows.length > 0;
}

/** Deletes challenge rows created before `cutoff` (LLD M31 rows have a 24h life; this is
 * housekeeping, not part of the LLD's own schema). Returns the number of rows removed. */
export async function purgeExpiredChallenges(db: Db, cutoff: Date, limit: number): Promise<number> {
  const res = await sql<{ id: string }>`
    delete from serving.public_removal_challenge
    where id in (
      select id from serving.public_removal_challenge where created_at < ${cutoff} order by created_at asc limit ${limit}
    )
    returning id
  `.execute(db);
  return res.rows.length;
}
