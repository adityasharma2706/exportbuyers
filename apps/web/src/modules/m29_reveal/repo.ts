/**
 * M29 — persistence for serving.reveal / serving.reveal_contact / serving.reveal_bulk
 * (db/migrations/0029_m29_contact_reveal.sql). Raw SQL throughout (as in M28's ledger.ts): the
 * partial-unique-index `on conflict ... where state = 'done'` and the multi-row transactional
 * writes need exact control that the generic scoped() builders do not expose.
 */
import { sql } from 'kysely';
import { registerTenantTable, scoped, type ActorContext, type ScopedDb } from '../m01_platform/index.js';
import type { Deliverability, RevealBulkItem, RevealBulkRow, RevealBulkState, RevealContactRow, RevealRow, RevealState } from './types.js';

registerTenantTable('serving.reveal', 'account');
registerTenantTable('serving.reveal_contact', 'account');
registerTenantTable('serving.reveal_bulk', 'account');

declare module '../m01_platform/tenancy.js' {
  interface TenantTableRows {
    'serving.reveal': RevealRow;
    'serving.reveal_contact': RevealContactRow;
    'serving.reveal_bulk': RevealBulkRow;
  }
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapReveal(r: Record<string, unknown>): RevealRow {
  return {
    id: String(r.id),
    account_id: String(r.account_id),
    company_id: String(r.company_id),
    state: r.state as RevealState,
    hold_id: r.hold_id === null || r.hold_id === undefined ? null : String(r.hold_id),
    commit_entry_id: r.commit_entry_id === null || r.commit_entry_id === undefined ? null : String(r.commit_entry_id),
    catalogue_version: r.catalogue_version === null || r.catalogue_version === undefined ? null : String(r.catalogue_version),
    created_at: toDate(r.created_at),
    updated_at: toDate(r.updated_at),
  };
}

function mapRevealContact(r: Record<string, unknown>): RevealContactRow {
  return {
    reveal_id: String(r.reveal_id),
    account_id: String(r.account_id),
    assertion_id: String(r.assertion_id),
    kind: String(r.kind),
    value_enc: Buffer.isBuffer(r.value_enc) ? r.value_enc : Buffer.from(r.value_enc as Buffer),
    deliverability: r.deliverability as Deliverability,
    checked_at: toDate(r.checked_at),
    created_at: toDate(r.created_at),
  };
}

function mapRevealBulk(r: Record<string, unknown>): RevealBulkRow {
  const results = Array.isArray(r.results) ? (r.results as RevealBulkItem[]) : (JSON.parse(String(r.results ?? '[]')) as RevealBulkItem[]);
  const companyIds = Array.isArray(r.company_ids) ? (r.company_ids as string[]).map(String) : [];
  return {
    id: String(r.id),
    account_id: String(r.account_id),
    state: r.state as RevealBulkState,
    company_ids: companyIds,
    confirmed_credits: Number(r.confirmed_credits),
    results,
    credits_charged: Number(r.credits_charged),
    error: r.error === null || r.error === undefined ? null : String(r.error),
    created_at: toDate(r.created_at),
    updated_at: toDate(r.updated_at),
  };
}

// ---- serving.reveal --------------------------------------------------------------------------

export async function findDoneReveal(ctx: ActorContext, companyId: string): Promise<RevealRow | null> {
  const db = scoped(ctx);
  const rows = await db.raw<Record<string, unknown>>(sql`
    select * from serving.reveal where account_id = ${ctx.accountId} and company_id = ${companyId} and state = 'done' limit 1
  `);
  return rows.length > 0 ? mapReveal(rows[0]!) : null;
}

/** company ids (of `companyIds`) that already have a `done` reveal for this account. */
export async function findDoneRevealCompanyIds(ctx: ActorContext, companyIds: readonly string[]): Promise<Set<string>> {
  if (companyIds.length === 0) return new Set();
  const db = scoped(ctx);
  const rows = await db.raw<{ company_id: string }>(sql`
    select company_id from serving.reveal
    where account_id = ${ctx.accountId} and state = 'done' and company_id = any(${[...companyIds]}::uuid[])
  `);
  return new Set(rows.map((r) => String(r.company_id)));
}

export interface RevealContactInsert {
  assertionId: string;
  kind: string;
  valueEnc: Buffer;
  deliverability: Deliverability;
  checkedAt: Date;
}

export interface RevealInsert {
  id: string;
  companyId: string;
  holdId: string | null;
  commitEntryId: string | null;
  catalogueVersion: string | null;
  contacts: readonly RevealContactInsert[];
}

/**
 * Inserts a `done` reveal and its contacts in one transaction (LLD M29 step 7: "Insert reveal +
 * reveal_contact and commit the hold in the same tx" — see service.ts for why the ledger commit
 * itself cannot literally share this transaction). Returns false when a concurrent request for the
 * same (account, company) already recorded a `done` reveal (the partial unique index caught it) —
 * the caller is then responsible for not double-charging.
 */
export async function insertRevealDone(ctx: ActorContext, accountId: string, params: RevealInsert): Promise<boolean> {
  return scoped(ctx).transaction(async (tx: ScopedDb) => {
    const rows = await tx.raw<{ id: string }>(sql`
      insert into serving.reveal (id, account_id, company_id, state, hold_id, commit_entry_id, catalogue_version, created_at, updated_at)
      values (${params.id}, ${accountId}, ${params.companyId}, 'done', ${params.holdId}, ${params.commitEntryId}, ${params.catalogueVersion}, now(), now())
      on conflict (account_id, company_id) where state = 'done' do nothing
      returning id
    `);
    if (rows.length === 0) return false;
    for (const c of params.contacts) {
      await tx.raw(sql`
        insert into serving.reveal_contact (reveal_id, account_id, assertion_id, kind, value_enc, deliverability, checked_at, created_at)
        values (${params.id}, ${accountId}, ${c.assertionId}, ${c.kind}, ${c.valueEnc}, ${c.deliverability}, ${c.checkedAt}, now())
      `);
    }
    return true;
  });
}

/**
 * Bulk variant: inserts several companies' `done` reveals (each with its own contacts) sharing one
 * commit_entry_id, in one transaction. Rows that lose the (account_id, company_id) `done` race are
 * skipped (`on conflict ... do nothing`); the caller gets back which ids were actually inserted.
 */
export async function insertRevealDoneMany(
  ctx: ActorContext,
  accountId: string,
  reveals: ReadonlyArray<RevealInsert>,
): Promise<Set<string>> {
  if (reveals.length === 0) return new Set();
  return scoped(ctx).transaction(async (tx: ScopedDb) => {
    const inserted = new Set<string>();
    for (const params of reveals) {
      const rows = await tx.raw<{ id: string }>(sql`
        insert into serving.reveal (id, account_id, company_id, state, hold_id, commit_entry_id, catalogue_version, created_at, updated_at)
        values (${params.id}, ${accountId}, ${params.companyId}, 'done', ${params.holdId}, ${params.commitEntryId}, ${params.catalogueVersion}, now(), now())
        on conflict (account_id, company_id) where state = 'done' do nothing
        returning id
      `);
      if (rows.length === 0) continue;
      inserted.add(params.companyId);
      for (const c of params.contacts) {
        await tx.raw(sql`
          insert into serving.reveal_contact (reveal_id, account_id, assertion_id, kind, value_enc, deliverability, checked_at, created_at)
          values (${params.id}, ${accountId}, ${c.assertionId}, ${c.kind}, ${c.valueEnc}, ${c.deliverability}, ${c.checkedAt}, now())
        `);
      }
    }
    return inserted;
  });
}

export async function listRevealContacts(ctx: ActorContext, revealId: string): Promise<RevealContactRow[]> {
  const db = scoped(ctx);
  const rows = await db.raw<Record<string, unknown>>(sql`
    select * from serving.reveal_contact where account_id = ${ctx.accountId} and reveal_id = ${revealId} order by kind, assertion_id
  `);
  return rows.map(mapRevealContact);
}

export interface RevealedContactJoinRow {
  companyId: string;
  revealId: string;
  assertionId: string;
  kind: string;
  valueEnc: Buffer;
  deliverability: Deliverability;
  checkedAt: Date;
}

/** IF-29b support: every revealed contact for this account, optionally filtered by company id. */
export async function listRevealedContactsForAccount(
  ctx: ActorContext,
  companyIds?: readonly string[],
): Promise<RevealedContactJoinRow[]> {
  const db = scoped(ctx);
  const rows =
    companyIds && companyIds.length > 0
      ? await db.raw<Record<string, unknown>>(sql`
          select r.company_id, rc.reveal_id, rc.assertion_id, rc.kind, rc.value_enc, rc.deliverability, rc.checked_at
          from serving.reveal r
          join serving.reveal_contact rc on rc.reveal_id = r.id and rc.account_id = r.account_id
          where r.account_id = ${ctx.accountId} and r.state = 'done' and r.company_id = any(${[...companyIds]}::uuid[])
          order by r.company_id, rc.kind
        `)
      : await db.raw<Record<string, unknown>>(sql`
          select r.company_id, rc.reveal_id, rc.assertion_id, rc.kind, rc.value_enc, rc.deliverability, rc.checked_at
          from serving.reveal r
          join serving.reveal_contact rc on rc.reveal_id = r.id and rc.account_id = r.account_id
          where r.account_id = ${ctx.accountId} and r.state = 'done'
          order by r.company_id, rc.kind
        `);
  return rows.map((r) => ({
    companyId: String(r.company_id),
    revealId: String(r.reveal_id),
    assertionId: String(r.assertion_id),
    kind: String(r.kind),
    valueEnc: Buffer.isBuffer(r.value_enc) ? r.value_enc : Buffer.from(r.value_enc as Buffer),
    deliverability: r.deliverability as Deliverability,
    checkedAt: toDate(r.checked_at),
  }));
}

// ---- serving.reveal_bulk ----------------------------------------------------------------------

export interface RevealBulkInsert {
  id: string;
  state: RevealBulkState;
  companyIds: readonly string[];
  confirmedCredits: number;
  results: readonly RevealBulkItem[];
  creditsCharged: number;
  error: string | null;
}

export async function insertRevealBulk(ctx: ActorContext, accountId: string, params: RevealBulkInsert): Promise<void> {
  const db = scoped(ctx);
  await db.raw(sql`
    insert into serving.reveal_bulk (id, account_id, state, company_ids, confirmed_credits, results, credits_charged, error, created_at, updated_at)
    values (${params.id}, ${accountId}, ${params.state}, ${[...params.companyIds]}::uuid[], ${params.confirmedCredits},
            ${JSON.stringify(params.results)}::jsonb, ${params.creditsCharged}, ${params.error}, now(), now())
  `);
}

export interface RevealBulkPatch {
  state?: RevealBulkState;
  results?: readonly RevealBulkItem[];
  creditsCharged?: number;
  error?: string | null;
}

export async function updateRevealBulk(ctx: ActorContext, id: string, patch: RevealBulkPatch): Promise<void> {
  const db = scoped(ctx);
  await db.raw(sql`
    update serving.reveal_bulk
    set state = coalesce(${patch.state ?? null}, state),
        results = coalesce(${patch.results !== undefined ? JSON.stringify(patch.results) : null}::jsonb, results),
        credits_charged = coalesce(${patch.creditsCharged ?? null}, credits_charged),
        error = case when ${patch.error !== undefined} then ${patch.error ?? null} else error end,
        updated_at = now()
    where account_id = ${ctx.accountId} and id = ${id}
  `);
}

export async function findRevealBulk(ctx: ActorContext, id: string): Promise<RevealBulkRow | null> {
  const db = scoped(ctx);
  const rows = await db.raw<Record<string, unknown>>(sql`
    select * from serving.reveal_bulk where account_id = ${ctx.accountId} and id = ${id} limit 1
  `);
  return rows.length > 0 ? mapRevealBulk(rows[0]!) : null;
}
