/**
 * M28 — the credits ledger core (IF-28a/b): hold, commit, release, refund, grant, balance,
 * consumeAllowance, allowanceRemaining (LLD M28).
 *
 * Double-entry model: every write inserts two or three ledger.entry rows sharing one txn_id whose
 * credits sum to zero across buckets (enforced again, deferred, by the DB trigger in the M28
 * migration):
 *   hold    available -N, held +N
 *   commit  held -N, spent +committed[, available +remainder]
 *   release held -N, available +N
 *   refund  spent -N, available +N
 *   grant   available +N, system -N   (system -N balances a grant materialising credits)
 *   expiry  available -N, system +N
 *
 * Every operation first calls ensureAndLockAccount(), which `select ... for update`s the account's
 * single ledger.account_balance_acct row for the rest of the transaction. That lock is what makes
 * the whole module correct under concurrency: a second request for the same account blocks until
 * the first commits, then re-reads state (including any idempotency-key row the first just wrote),
 * so idempotency and the available-credits check never race.
 */
import { sql } from 'kysely';
import { AppError, newId, type ActorContext } from '../m01_platform/index.js';
import { getCatalogue } from './catalogue.js';
import { creditsConfig } from './config.js';
import { systemExec, userExec, type Exec } from './exec.js';
import { istPeriod } from './time.js';
import type {
  AllowanceKind,
  Balance,
  CommitOptions,
  CommitResult,
  EntryBucket,
  EntryKind,
  EntryRow,
  GrantParams,
  GrantResult,
  HoldParams,
  RefundParams,
  RefundResult,
} from './types.js';

// -------------------------------------------------------------------------------------------
// Row mapping + low-level helpers (also used by jobs.ts and history.ts)
// -------------------------------------------------------------------------------------------

export function mapEntry(r: Record<string, unknown>): EntryRow {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    txnId: String(r.txn_id),
    kind: String(r.kind) as EntryKind,
    bucket: String(r.bucket) as EntryBucket,
    credits: Number(r.credits),
    actionType: r.action_type === null || r.action_type === undefined ? null : String(r.action_type),
    actionRef: r.action_ref === null || r.action_ref === undefined ? null : String(r.action_ref),
    catalogueVersion: r.catalogue_version === null || r.catalogue_version === undefined ? null : String(r.catalogue_version),
    refersTo: r.refers_to === null || r.refers_to === undefined ? null : String(r.refers_to),
    idempotencyKey: String(r.idempotency_key),
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : new Date(r.expires_at as string | number | Date),
    createdAt: new Date(r.created_at as string | number | Date),
  };
}

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';
}

export async function ensureAndLockAccount(exec: Exec, accountId: string): Promise<void> {
  await exec.run(sql`insert into ledger.account_balance_acct (account_id) values (${accountId}) on conflict (account_id) do nothing`);
  await exec.run(sql`select account_id from ledger.account_balance_acct where account_id = ${accountId} for update`);
}

async function ensureCacheRow(exec: Exec, accountId: string): Promise<void> {
  await exec.run(
    sql`insert into ledger.balance_cache (account_id, available, held, updated_at) values (${accountId}, 0, 0, now()) on conflict (account_id) do nothing`,
  );
}

interface BalanceCacheRow {
  available: number | string;
  held: number | string;
}

async function readBalanceLocked(exec: Exec, accountId: string): Promise<Balance> {
  await ensureCacheRow(exec, accountId);
  const rows = await exec.run(sql<BalanceCacheRow>`select available, held from ledger.balance_cache where account_id = ${accountId}`);
  const r = rows[0];
  return { available: Number(r?.available ?? 0), held: Number(r?.held ?? 0) };
}

export async function bumpCache(exec: Exec, accountId: string, delta: { available?: number; held?: number }): Promise<void> {
  await ensureCacheRow(exec, accountId);
  await exec.run(sql`
    update ledger.balance_cache
    set available = available + ${delta.available ?? 0}, held = held + ${delta.held ?? 0}, updated_at = now()
    where account_id = ${accountId}
  `);
}

interface EntryInsert {
  id: string;
  accountId: string;
  txnId: string;
  kind: EntryKind;
  bucket: EntryBucket;
  credits: number;
  actionType?: string | null;
  actionRef?: string | null;
  catalogueVersion?: string | null;
  refersTo?: string | null;
  idempotencyKey: string;
  expiresAt?: Date | null;
}

export async function insertEntry(exec: Exec, e: EntryInsert): Promise<void> {
  await exec.run(sql`
    insert into ledger.entry
      (id, account_id, txn_id, kind, bucket, credits, action_type, action_ref, catalogue_version, refers_to, idempotency_key, expires_at, created_at)
    values
      (${e.id}, ${e.accountId}, ${e.txnId}, ${e.kind}, ${e.bucket}, ${e.credits}, ${e.actionType ?? null}, ${e.actionRef ?? null},
       ${e.catalogueVersion ?? null}, ${e.refersTo ?? null}, ${e.idempotencyKey}, ${e.expiresAt ?? null}, now())
  `);
}

async function entriesByIdemKey(exec: Exec, accountId: string, key: string): Promise<EntryRow[]> {
  const rows = await exec.run(sql<Record<string, unknown>>`
    select * from ledger.entry where account_id = ${accountId} and idempotency_key = ${key} order by created_at asc, id asc
  `);
  return rows.map(mapEntry);
}

async function entryById(exec: Exec, id: string): Promise<EntryRow | null> {
  const rows = await exec.run(sql<Record<string, unknown>>`select * from ledger.entry where id = ${id}`);
  return rows.length > 0 ? mapEntry(rows[0]!) : null;
}

async function terminalFor(exec: Exec, holdId: string): Promise<EntryRow | null> {
  const rows = await exec.run(sql<Record<string, unknown>>`
    select * from ledger.entry where refers_to = ${holdId} and kind in ('commit', 'release') order by created_at asc limit 1
  `);
  return rows.length > 0 ? mapEntry(rows[0]!) : null;
}

async function spentEntryFor(exec: Exec, holdId: string): Promise<EntryRow | null> {
  const rows = await exec.run(sql<Record<string, unknown>>`
    select * from ledger.entry where refers_to = ${holdId} and kind = 'commit' and bucket = 'spent' limit 1
  `);
  return rows.length > 0 ? mapEntry(rows[0]!) : null;
}

interface RefundTotalRow {
  total: number | string | null;
}

async function sumRefunds(exec: Exec, commitEntryId: string): Promise<number> {
  const rows = await exec.run(sql<RefundTotalRow>`
    select coalesce(sum(-credits), 0) as total from ledger.entry where refers_to = ${commitEntryId} and kind = 'refund' and bucket = 'spent'
  `);
  return Number(rows[0]?.total ?? 0);
}

function validatePositiveInt(n: unknown, field: string): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new AppError('VALIDATION', `${field} must be a positive integer`, { field });
  }
  return n;
}

function requireIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 400) {
    throw new AppError('VALIDATION', 'idempotencyKey must be 1..400 characters', { field: 'idempotencyKey' });
  }
  return key;
}

// -------------------------------------------------------------------------------------------
// hold / commit / release
// -------------------------------------------------------------------------------------------

/** IF-28a. Throws INSUFFICIENT_CREDITS if available < credits. */
export async function hold(ctx: ActorContext, params: HoldParams): Promise<{ holdId: string }> {
  const credits = validatePositiveInt(params.credits, 'credits');
  if (typeof params.actionType !== 'string' || params.actionType.length === 0) {
    throw new AppError('VALIDATION', 'actionType is required', { field: 'actionType' });
  }
  const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);
  const ttlSec = params.ttlSec ?? creditsConfig().defaultHoldTtlSec;
  if (!Number.isInteger(ttlSec) || ttlSec <= 0) throw new AppError('VALIDATION', 'ttlSec must be a positive integer', { field: 'ttlSec' });
  const actionRef = params.actionRef ?? null;

  const { exec, accountId } = userExec(ctx);
  return exec.transaction(async (tx) => {
    await ensureAndLockAccount(tx, accountId);

    const existing = await entriesByIdemKey(tx, accountId, idempotencyKey);
    if (existing.length > 0) {
      const heldRow = existing.find((r) => r.kind === 'hold' && r.bucket === 'held');
      if (!heldRow) throw new AppError('CONFLICT', 'Idempotency-Key was already used for a different ledger operation', { idempotencyKey });
      if (heldRow.credits !== credits || heldRow.actionType !== params.actionType || heldRow.actionRef !== actionRef) {
        throw new AppError('CONFLICT', 'Idempotency-Key was already used with different parameters', { idempotencyKey });
      }
      return { holdId: heldRow.id };
    }

    const balance = await readBalanceLocked(tx, accountId);
    if (balance.available < credits) {
      throw new AppError('INSUFFICIENT_CREDITS', 'Not enough available credits', { available: balance.available, required: credits });
    }

    const txnId = newId();
    const holdEntryId = newId();
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    const catalogueVersion = getCatalogue().version;
    try {
      await insertEntry(tx, {
        id: newId(),
        accountId,
        txnId,
        kind: 'hold',
        bucket: 'available',
        credits: -credits,
        actionType: params.actionType,
        actionRef,
        catalogueVersion,
        idempotencyKey,
      });
      await insertEntry(tx, {
        id: holdEntryId,
        accountId,
        txnId,
        kind: 'hold',
        bucket: 'held',
        credits,
        actionType: params.actionType,
        actionRef,
        catalogueVersion,
        idempotencyKey,
        expiresAt,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'Idempotency-Key was already used', { idempotencyKey });
      throw e;
    }
    await bumpCache(tx, accountId, { available: -credits, held: credits });
    return { holdId: holdEntryId };
  });
}

/** Shared by the user-facing release() and the m28.sweep_expired_holds job. Idempotent: releasing
 * an already-released hold is a no-op; releasing an already-committed hold throws CONFLICT. */
export async function performRelease(exec: Exec, accountId: string, holdRow: EntryRow): Promise<boolean> {
  await ensureAndLockAccount(exec, accountId);
  const terminal = await terminalFor(exec, holdRow.id);
  if (terminal) {
    if (terminal.kind === 'release') return false;
    throw new AppError('CONFLICT', 'Hold was already committed');
  }
  const idempotencyKey = `release:${holdRow.id}`;
  const txnId = newId();
  try {
    await insertEntry(exec, {
      id: newId(),
      accountId,
      txnId,
      kind: 'release',
      bucket: 'held',
      credits: -holdRow.credits,
      actionType: holdRow.actionType,
      actionRef: holdRow.actionRef,
      catalogueVersion: holdRow.catalogueVersion,
      refersTo: holdRow.id,
      idempotencyKey,
    });
    await insertEntry(exec, {
      id: newId(),
      accountId,
      txnId,
      kind: 'release',
      bucket: 'available',
      credits: holdRow.credits,
      actionType: holdRow.actionType,
      actionRef: holdRow.actionRef,
      catalogueVersion: holdRow.catalogueVersion,
      refersTo: holdRow.id,
      idempotencyKey,
    });
  } catch (e) {
    if (isUniqueViolation(e)) return false; // a concurrent release already recorded this hold
    throw e;
  }
  await bumpCache(exec, accountId, { held: -holdRow.credits, available: holdRow.credits });
  return true;
}

/** IF-28a. */
export async function release(ctx: ActorContext, holdId: string): Promise<void> {
  if (typeof holdId !== 'string' || holdId.length === 0) throw new AppError('VALIDATION', 'holdId is required', { field: 'holdId' });
  const { exec, accountId } = userExec(ctx);
  await exec.transaction(async (tx) => {
    const holdRow = await entryById(tx, holdId);
    if (!holdRow || holdRow.accountId !== accountId || holdRow.kind !== 'hold' || holdRow.bucket !== 'held') {
      throw new AppError('NOT_FOUND', 'Hold not found');
    }
    await performRelease(tx, accountId, holdRow);
  });
}

/** IF-28a. `credits` must be <= the held amount; any remainder is released. Committing an
 * expired or already-released hold throws CONFLICT (LLD M28 rule: "M29 must re-hold"). */
export async function commit(ctx: ActorContext, holdId: string, opts: CommitOptions = {}): Promise<CommitResult> {
  if (typeof holdId !== 'string' || holdId.length === 0) throw new AppError('VALIDATION', 'holdId is required', { field: 'holdId' });
  const { exec, accountId } = userExec(ctx);

  return exec.transaction(async (tx) => {
    await ensureAndLockAccount(tx, accountId);
    const holdRow = await entryById(tx, holdId);
    if (!holdRow || holdRow.accountId !== accountId || holdRow.kind !== 'hold' || holdRow.bucket !== 'held') {
      throw new AppError('NOT_FOUND', 'Hold not found');
    }
    const requested = opts.credits ?? holdRow.credits;
    if (!Number.isInteger(requested) || requested < 0 || requested > holdRow.credits) {
      throw new AppError('VALIDATION', 'credits must be between 0 and the held amount', { held: holdRow.credits });
    }

    const terminal = await terminalFor(tx, holdId);
    if (terminal) {
      if (terminal.kind === 'release') throw new AppError('CONFLICT', 'Hold was already released or has expired');
      const spentRow = await spentEntryFor(tx, holdId);
      if (!spentRow || spentRow.credits !== requested) {
        throw new AppError('CONFLICT', 'Hold was already committed with a different amount', { idempotencyKey: `commit:${holdId}` });
      }
      return { commitEntryId: spentRow.id, committed: spentRow.credits, released: holdRow.credits - spentRow.credits };
    }
    if (holdRow.expiresAt !== null && holdRow.expiresAt.getTime() <= Date.now()) {
      throw new AppError('CONFLICT', 'Hold has expired; re-hold before committing');
    }

    const remainder = holdRow.credits - requested;
    const txnId = newId();
    const commitEntryId = newId();
    const idempotencyKey = `commit:${holdId}`;
    try {
      await insertEntry(tx, {
        id: newId(),
        accountId,
        txnId,
        kind: 'commit',
        bucket: 'held',
        credits: -holdRow.credits,
        actionType: holdRow.actionType,
        actionRef: holdRow.actionRef,
        catalogueVersion: holdRow.catalogueVersion,
        refersTo: holdId,
        idempotencyKey,
      });
      await insertEntry(tx, {
        id: commitEntryId,
        accountId,
        txnId,
        kind: 'commit',
        bucket: 'spent',
        credits: requested,
        actionType: holdRow.actionType,
        actionRef: holdRow.actionRef,
        catalogueVersion: holdRow.catalogueVersion,
        refersTo: holdId,
        idempotencyKey,
      });
      if (remainder > 0) {
        await insertEntry(tx, {
          id: newId(),
          accountId,
          txnId,
          kind: 'commit',
          bucket: 'available',
          credits: remainder,
          actionType: holdRow.actionType,
          actionRef: holdRow.actionRef,
          catalogueVersion: holdRow.catalogueVersion,
          refersTo: holdId,
          idempotencyKey,
        });
      }
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'Hold was already committed', { idempotencyKey });
      throw e;
    }
    await bumpCache(tx, accountId, { held: -holdRow.credits, available: remainder });
    return { commitEntryId, committed: requested, released: remainder };
  });
}

// -------------------------------------------------------------------------------------------
// refund / grant
// -------------------------------------------------------------------------------------------

/** IF-28a. `ctx.kind` of 'system'/'admin' may refund any account's commit; a user ctx may only
 * refund its own account's commits. Enforces Σ refunds ≤ committed. */
export async function refund(ctx: ActorContext, params: RefundParams): Promise<RefundResult> {
  const credits = validatePositiveInt(params.credits, 'credits');
  if (typeof params.refersTo !== 'string' || params.refersTo.length === 0) {
    throw new AppError('VALIDATION', 'refersTo is required', { field: 'refersTo' });
  }
  if (typeof params.reason !== 'string' || params.reason.trim().length === 0) {
    throw new AppError('VALIDATION', 'reason is required', { field: 'reason' });
  }
  const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);

  const isSystem = ctx.kind === 'system' || ctx.kind === 'admin';
  const exec = isSystem ? systemExec(`refund: ${params.reason}`, ctx) : userExec(ctx).exec;

  return exec.transaction(async (tx) => {
    const commitRow = await entryById(tx, params.refersTo);
    if (!commitRow || commitRow.kind !== 'commit' || commitRow.bucket !== 'spent') {
      throw new AppError('NOT_FOUND', 'Committed entry not found');
    }
    if (!isSystem && commitRow.accountId !== ctx.accountId) {
      throw new AppError('NOT_FOUND', 'Committed entry not found');
    }
    const accountId = commitRow.accountId;
    await ensureAndLockAccount(tx, accountId);

    const existing = await entriesByIdemKey(tx, accountId, idempotencyKey);
    if (existing.length > 0) {
      const spentSide = existing.find((r) => r.kind === 'refund' && r.bucket === 'spent');
      if (!spentSide || spentSide.refersTo !== params.refersTo || -spentSide.credits !== credits) {
        throw new AppError('CONFLICT', 'Idempotency-Key was already used with different parameters', { idempotencyKey });
      }
      return { refundEntryId: spentSide.id, refunded: credits };
    }

    const alreadyRefunded = await sumRefunds(tx, params.refersTo);
    const maxAdditional = Math.max(0, commitRow.credits - alreadyRefunded);
    if (credits > maxAdditional) {
      throw new AppError('CONFLICT', 'Refunds cannot exceed the committed amount', {
        committed: commitRow.credits,
        alreadyRefunded,
        requested: credits,
        maxAdditional,
      });
    }

    const txnId = newId();
    const refundEntryId = newId();
    try {
      await insertEntry(tx, {
        id: refundEntryId,
        accountId,
        txnId,
        kind: 'refund',
        bucket: 'spent',
        credits: -credits,
        actionType: commitRow.actionType,
        actionRef: commitRow.actionRef,
        catalogueVersion: commitRow.catalogueVersion,
        refersTo: params.refersTo,
        idempotencyKey,
      });
      await insertEntry(tx, {
        id: newId(),
        accountId,
        txnId,
        kind: 'refund',
        bucket: 'available',
        credits,
        actionType: commitRow.actionType,
        actionRef: commitRow.actionRef,
        catalogueVersion: commitRow.catalogueVersion,
        refersTo: params.refersTo,
        idempotencyKey,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'Idempotency-Key was already used', { idempotencyKey });
      throw e;
    }
    await bumpCache(tx, accountId, { available: credits });
    return { refundEntryId, refunded: credits };
  });
}

/** IF-28a. System/admin only. `kind` 'grant'/'topup' require positive credits; 'adjustment' may
 * be negative (never taking available below zero). */
export async function grant(ctx: ActorContext, params: GrantParams): Promise<GrantResult> {
  if (ctx.kind !== 'system' && ctx.kind !== 'admin') {
    throw new AppError('FORBIDDEN', 'grant() may only be called by a system or admin actor');
  }
  if (typeof params.accountId !== 'string' || params.accountId.length === 0) {
    throw new AppError('VALIDATION', 'accountId is required', { field: 'accountId' });
  }
  if (params.kind !== 'grant' && params.kind !== 'topup' && params.kind !== 'adjustment') {
    throw new AppError('VALIDATION', 'kind must be grant, topup or adjustment', { field: 'kind' });
  }
  if (typeof params.reason !== 'string' || params.reason.trim().length === 0) {
    throw new AppError('VALIDATION', 'reason is required', { field: 'reason' });
  }
  const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);
  if (!Number.isInteger(params.credits) || params.credits === 0) {
    throw new AppError('VALIDATION', 'credits must be a non-zero integer', { field: 'credits' });
  }
  if (params.kind !== 'adjustment' && params.credits <= 0) {
    throw new AppError('VALIDATION', 'grant/topup credits must be positive', { field: 'credits' });
  }
  const expiresAt = params.expiresAt ?? null;

  const exec = systemExec(`${params.kind}: ${params.reason}`, ctx);
  return exec.transaction(async (tx) => {
    await ensureAndLockAccount(tx, params.accountId);

    const existing = await entriesByIdemKey(tx, params.accountId, idempotencyKey);
    if (existing.length > 0) {
      const availSide = existing.find((r) => r.bucket === 'available' && r.kind === params.kind);
      if (!availSide || availSide.credits !== params.credits) {
        throw new AppError('CONFLICT', 'Idempotency-Key was already used with different parameters', { idempotencyKey });
      }
      return { grantEntryId: availSide.id };
    }

    if (params.credits < 0) {
      const balance = await readBalanceLocked(tx, params.accountId);
      if (balance.available + params.credits < 0) {
        throw new AppError('CONFLICT', 'Adjustment would take available credits below zero', {
          available: balance.available,
          credits: params.credits,
        });
      }
    }

    const txnId = newId();
    const grantEntryId = newId();
    try {
      await insertEntry(tx, {
        id: grantEntryId,
        accountId: params.accountId,
        txnId,
        kind: params.kind,
        bucket: 'available',
        credits: params.credits,
        idempotencyKey,
        expiresAt,
      });
      await insertEntry(tx, {
        id: newId(),
        accountId: params.accountId,
        txnId,
        kind: params.kind,
        bucket: 'system',
        credits: -params.credits,
        idempotencyKey,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'Idempotency-Key was already used', { idempotencyKey });
      throw e;
    }
    await bumpCache(tx, params.accountId, { available: params.credits });
    return { grantEntryId };
  });
}

// -------------------------------------------------------------------------------------------
// balance / allowance
// -------------------------------------------------------------------------------------------

/** IF-28a. A plain cached read; does not take the account lock (only writers need to serialise). */
export async function balance(ctx: ActorContext): Promise<Balance> {
  const { exec, accountId } = userExec(ctx);
  await ensureCacheRow(exec, accountId);
  const rows = await exec.run(sql<BalanceCacheRow>`select available, held from ledger.balance_cache where account_id = ${accountId}`);
  const r = rows[0];
  return { available: Number(r?.available ?? 0), held: Number(r?.held ?? 0) };
}

function allowanceCap(ctx: ActorContext, kind: AllowanceKind): number {
  return kind === 'reveal' ? ctx.entitlements.revealsIncludedPerMonth : ctx.entitlements.checksPerMonth;
}

/** IF-28a. Returns true when `n` units were covered by the free allowance (no credits needed). */
export async function consumeAllowance(ctx: ActorContext, kind: AllowanceKind, n = 1): Promise<boolean> {
  if (!Number.isInteger(n) || n <= 0) throw new AppError('VALIDATION', 'n must be a positive integer', { field: 'n' });
  const cap = allowanceCap(ctx, kind);
  if (cap <= 0) return false;
  const { exec, accountId } = userExec(ctx);
  const period = istPeriod();

  return exec.transaction(async (tx) => {
    await tx.run(sql`
      insert into ledger.allowance_usage (account_id, period, kind, used, created_at, updated_at)
      values (${accountId}, ${period}, ${kind}, 0, now(), now())
      on conflict (account_id, period, kind) do nothing
    `);
    const rows = await tx.run(sql<{ used: number | string }>`
      update ledger.allowance_usage
      set used = used + ${n}, updated_at = now()
      where account_id = ${accountId} and period = ${period} and kind = ${kind} and used + ${n} <= ${cap}
      returning used
    `);
    return rows.length > 0;
  });
}

/** IF-28a. */
export async function allowanceRemaining(ctx: ActorContext): Promise<Record<AllowanceKind, number>> {
  const { exec, accountId } = userExec(ctx);
  const period = istPeriod();
  const rows = await exec.run(sql<{ kind: string; used: number | string }>`
    select kind, used from ledger.allowance_usage where account_id = ${accountId} and period = ${period}
  `);
  const used: Record<AllowanceKind, number> = { reveal: 0, check: 0 };
  for (const r of rows) {
    const k = r.kind;
    if (k === 'reveal' || k === 'check') used[k] = Number(r.used);
  }
  return {
    reveal: Math.max(0, ctx.entitlements.revealsIncludedPerMonth - used.reveal),
    check: Math.max(0, ctx.entitlements.checksPerMonth - used.check),
  };
}

/**
 * Reverses a previous consumeAllowance() call. Not part of IF-28's documented function list, but
 * M29's own LLD section requires it ("consumeAllowance and its undo are both keyed by the reveal
 * id", e.g. when a reveal turns up zero valid contacts) and M28 owns allowance_usage, so the undo
 * lives here rather than duplicating the table elsewhere. Floors at zero; a double-undo is a safe
 * no-op rather than an error, since the caller is expected to key its own idempotency externally.
 */
export async function undoAllowance(ctx: ActorContext, kind: AllowanceKind, n = 1): Promise<void> {
  if (!Number.isInteger(n) || n <= 0) throw new AppError('VALIDATION', 'n must be a positive integer', { field: 'n' });
  const { exec, accountId } = userExec(ctx);
  const period = istPeriod();
  await exec.run(sql`
    update ledger.allowance_usage
    set used = greatest(0, used - ${n}), updated_at = now()
    where account_id = ${accountId} and period = ${period} and kind = ${kind}
  `);
}

// -------------------------------------------------------------------------------------------
// Monthly free grant expiry (used by jobs.ts)
// -------------------------------------------------------------------------------------------

/**
 * How much of `grantRow` (a 'grant' entry with an expiry) is still unspent, assuming it is the
 * only currently-open expiring lot for the account — true for the monthly free grant by
 * construction, since the next month's grant is only issued after the previous one's expires_at
 * has passed (LLD M28 Rules). Under that invariant, FIFO-by-expiry consumption means every
 * 'available'-bucket movement after the grant was issued draws on it first, so the net change in
 * the 'available' bucket since the grant (excluding the grant's own row) is exactly the amount
 * consumed from it, capped at what was granted.
 */
export async function computeGrantRemaining(exec: Exec, grantRow: EntryRow): Promise<number> {
  const rows = await exec.run(sql<{ net: number | string | null }>`
    select coalesce(sum(credits), 0) as net
    from ledger.entry
    where account_id = ${grantRow.accountId} and bucket = 'available' and id <> ${grantRow.id} and created_at > ${grantRow.createdAt}
  `);
  const net = Number(rows[0]?.net ?? 0);
  const consumed = Math.max(0, -net);
  return Math.max(0, Math.min(grantRow.credits, grantRow.credits - consumed));
}

/** Writes an `expiry` entry pair for whatever of `grantRow` remains unspent. Idempotent: a
 * second call for the same grant is a no-op (an existing expiry row, or — once one is written —
 * computeGrantRemaining() itself settles to zero, because the expiry entry is itself an
 * 'available'-bucket movement counted in the net-change sum). Returns the amount expired. */
export async function expireGrantIfDue(exec: Exec, grantRow: EntryRow): Promise<number> {
  await ensureAndLockAccount(exec, grantRow.accountId);
  const already = await exec.run(sql`select 1 from ledger.entry where refers_to = ${grantRow.id} and kind = 'expiry' limit 1`);
  if (already.length > 0) return 0;
  const remaining = await computeGrantRemaining(exec, grantRow);
  if (remaining <= 0) return 0;

  const txnId = newId();
  const idempotencyKey = `expiry:${grantRow.id}`;
  try {
    await insertEntry(exec, {
      id: newId(),
      accountId: grantRow.accountId,
      txnId,
      kind: 'expiry',
      bucket: 'available',
      credits: -remaining,
      refersTo: grantRow.id,
      idempotencyKey,
    });
    await insertEntry(exec, {
      id: newId(),
      accountId: grantRow.accountId,
      txnId,
      kind: 'expiry',
      bucket: 'system',
      credits: remaining,
      refersTo: grantRow.id,
      idempotencyKey,
    });
  } catch (e) {
    if (isUniqueViolation(e)) return 0;
    throw e;
  }
  await bumpCache(exec, grantRow.accountId, { available: -remaining });
  return remaining;
}
