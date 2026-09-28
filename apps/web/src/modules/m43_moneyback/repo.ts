/**
 * M43 — read-only cross-module lookups plus the one cross-module write the outcome handler needs.
 * M43 owns no schema table of its own (LLD M43 has no "Schema" block: "Files billing.money_back"
 * against M11's own `serving.review_item`, with the request payload carrying everything the
 * outcome handler needs — same shape M31's `removal.request` uses).
 *
 *   - `serving.payment` belongs to M36. Reading it here (to find "the first paid payment" and its
 *     age) and writing `status = 'refunded'` on approval follow the same pattern M30's repo.ts
 *     documents for reading M29's `serving.reveal`/`serving.reveal_contact` and M28's
 *     `ledger.entry`: a narrow, read/write-documented raw-SQL cross-module access, because M36's
 *     public API (IF-36) exposes no "find the account's first captured payment" or "mark a
 *     payment refunded" primitive — the latter because, before this module existed, nothing in
 *     the codebase ever set a payment to `refunded` at all (M36's PaymentStatus union always
 *     included it, for exactly this future writer).
 *   - `ledger.entry` belongs to M28. Reading it here (to size the plan-grant "adjustment" LLD M43
 *     step 3 requires) mirrors M30's own read of `ledger.entry` for the identical reason: IF-28a
 *     exposes `computeGrantRemaining(exec, grantRow)` but not a way to find *which* grant row is
 *     the account's live plan grant, since only M28's own jobs (the monthly-grant sweep) and M36's
 *     webhook (which never surfaces the grant's ledger entry id back to the caller) create one.
 *   - `serving.member` belongs to M05. Reading it here for the requester's email exactly mirrors
 *     M41's own `primaryEmailForAccount()` (same query, same reasoning), duplicated rather than
 *     imported because M41 does not export it and is not one of this module's declared deps.
 */
import { sql } from 'kysely';
import { AppError, scoped, systemDb, type ActorContext } from '../m01_platform/index.js';
import type { Tx } from '../m02_queue/index.js';
import type { PaymentLookupRow } from './types.js';

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

// ---- M36's serving.payment (read-only, plus the one documented status write) -------------------

function mapPaymentLookup(r: Record<string, unknown>): PaymentLookupRow {
  return {
    id: String(r.id),
    razorpayPaymentId: String(r.razorpay_payment_id),
    amountPaise: Number(r.amount_paise),
    status: String(r.status),
    createdAt: toDate(r.created_at),
  };
}

/** The account's earliest `captured` payment (LLD M43: "the first paid payment"). Once that
 * payment is marked `refunded` (by `markPaymentRefunded` below), a repeat request naturally finds
 * either an even-earlier `captured` row (there is none, by definition) or nothing at all, so a
 * second money-back request against the same payment is rejected without any extra bookkeeping. */
export async function findFirstCapturedPayment(ctx: ActorContext): Promise<PaymentLookupRow | null> {
  const db = scoped(ctx);
  const rows = await db.raw<Record<string, unknown>>(sql`
    select id, razorpay_payment_id, amount_paise, status, created_at
    from serving.payment
    where account_id = ${ctx.accountId} and status = 'captured'
    order by created_at asc
    limit 1
  `);
  return rows.length > 0 ? mapPaymentLookup(rows[0]!) : null;
}

/** Marks a payment `refunded` after the Razorpay refund actually succeeds (LLD M43 approve step
 * 1). Idempotent: a retried handler re-running this after the first success just re-sets the same
 * value. */
export async function markPaymentRefunded(tx: Tx, paymentId: string): Promise<void> {
  await sql`update serving.payment set status = 'refunded' where id = ${paymentId}`.execute(tx);
}

// ---- M28's ledger.entry (read-only) --------------------------------------------------------------

export interface ActivePlanGrant {
  id: string;
  credits: number;
  createdAt: Date;
}

/** The account's live plan-grant ledger entry, if any (LLD M36 webhook rule: `grant()` is called
 * with idempotency key `plan:<sub>:<period_start>` on `subscription.activated`/`.charged`).
 * "Live" = not yet expired; the monthly-free grant uses the unrelated `free:<acct>:<YYYY-MM>` key
 * prefix and is deliberately excluded, since LLD M43 step 3 only removes the *plan* grant. */
export async function findActivePlanGrant(tx: Tx, accountId: string): Promise<ActivePlanGrant | null> {
  const rows = await sql<{ id: string; credits: number | string; created_at: unknown }>`
    select id, credits, created_at
    from ledger.entry
    where account_id = ${accountId} and kind = 'grant' and bucket = 'available'
      and idempotency_key like 'plan:%'
      and (expires_at is null or expires_at > now())
    order by created_at desc
    limit 1
  `.execute(tx);
  const row = rows.rows[0];
  if (!row) return null;
  return { id: String(row.id), credits: Number(row.credits), createdAt: toDate(row.created_at) };
}

/**
 * How much of `grant` is still unspent, assuming it is the account's only currently-open
 * expiring lot — true here because a money-back request is only ever eligible against the first
 * paid payment (LLD M43), so at most one plan grant has ever been issued to the account at the
 * point this runs. Identical formula to M28's own (private) `computeGrantRemaining`, documented
 * there with the same invariant; not reused directly because M28's `Exec` abstraction is not part
 * of its public API (IF-28a exports the functions built on it, not the type itself).
 */
export async function computeActivePlanGrantRemaining(tx: Tx, accountId: string, grant: ActivePlanGrant): Promise<number> {
  const rows = await sql<{ net: number | string | null }>`
    select coalesce(sum(credits), 0) as net
    from ledger.entry
    where account_id = ${accountId} and bucket = 'available' and id <> ${grant.id} and created_at > ${grant.createdAt}
  `.execute(tx);
  const net = Number(rows.rows[0]?.net ?? 0);
  const consumed = Math.max(0, -net);
  return Math.max(0, Math.min(grant.credits, grant.credits - consumed));
}

// ---- M05's serving.member (read-only account email lookup) --------------------------------------

/** Mirrors M41's own `primaryEmailForAccount` (see file header). */
export async function primaryEmailForAccount(accountId: string): Promise<string | null> {
  if (typeof accountId !== 'string' || accountId.length === 0) throw new AppError('VALIDATION', 'accountId is required');
  const rows = await sql<{ email: string }>`
    select email from serving.member
    where account_id = ${accountId} and email is not null and erased_at is null
    order by (role = 'owner') desc, created_at asc
    limit 1
  `.execute(systemDb('m43: resolve account email for a money-back request'));
  return rows.rows[0]?.email ?? null;
}
