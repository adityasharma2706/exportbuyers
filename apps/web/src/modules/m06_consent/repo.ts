/**
 * M06 — persistence for serving.privacy_notice and serving.consent_event.
 *
 * currentConsent() is keyed by accountId rather than an actor (other modules — M41 email,
 * M50 WhatsApp, M38 data rights — ask about accounts from background jobs), so reads go
 * through systemDb() with a logged reason. The ledger is registered as an account-scoped
 * tenant table so later modules may also read it through scoped(ctx).
 */
import { sql } from 'kysely';
import { registerTenantTable, systemDb, type Db, type Id } from '../m01_platform/index.js';
import type { ConsentAction, ConsentChannel, ConsentEvent, NoticeLocale, PrivacyNotice, Purpose } from './types.js';

registerTenantTable('serving.consent_event', 'account');

/** Raw row shape of serving.consent_event, for callers reading it through scoped(ctx). */
export interface ConsentEventRow {
  id: string;
  account_id: string;
  member_id: string | null;
  purpose: Purpose;
  action: ConsentAction;
  notice_version: string;
  channel: ConsentChannel;
  ip: string | null;
  at: Date;
}

declare module '../m01_platform/tenancy.js' {
  interface TenantTableRows {
    'serving.consent_event': ConsentEventRow;
  }
}

const db = (reason: string): Db => systemDb(`m06: ${reason}`);

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function mapNotice(r: Record<string, unknown>): PrivacyNotice {
  return {
    version: String(r.version),
    locale: r.locale as NoticeLocale,
    bodyMd: String(r.body_md),
    publishedAt: toDate(r.published_at),
    sha256: String(r.sha256),
  };
}

function mapEvent(r: Record<string, unknown>): ConsentEvent {
  return {
    id: String(r.id) as Id<'consent_event'>,
    accountId: String(r.account_id) as Id<'account'>,
    memberId: r.member_id === null || r.member_id === undefined ? null : (String(r.member_id) as Id<'member'>),
    purpose: r.purpose as Purpose,
    action: r.action as ConsentAction,
    noticeVersion: String(r.notice_version),
    channel: r.channel as ConsentChannel,
    ip: r.ip === null || r.ip === undefined ? null : String(r.ip),
    at: toDate(r.at),
  };
}

// ---- notices -------------------------------------------------------------------------------

export async function insertNotice(n: PrivacyNotice, reasonDb: Db): Promise<void> {
  await reasonDb
    .insertInto('serving.privacy_notice')
    .values({
      version: n.version,
      locale: n.locale,
      body_md: n.bodyMd,
      published_at: n.publishedAt,
      sha256: n.sha256,
    })
    .execute();
}

export async function getNotice(version: string, tx?: Db): Promise<PrivacyNotice | undefined> {
  const r = (await (tx ?? db('read privacy notice'))
    .selectFrom('serving.privacy_notice')
    .selectAll()
    .where('version', '=', version)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapNotice(r) : undefined;
}

/** The latest notice for a locale whose publication time has arrived. */
export async function findCurrentNotice(locale: NoticeLocale, now: Date, tx?: Db): Promise<PrivacyNotice | undefined> {
  const r = (await (tx ?? db('read current privacy notice'))
    .selectFrom('serving.privacy_notice')
    .selectAll()
    .where('locale', '=', locale)
    .where('published_at', '<=', now)
    .orderBy('published_at', 'desc')
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapNotice(r) : undefined;
}

/** The current notice of every locale that has one. */
export async function findCurrentNotices(now: Date, tx?: Db): Promise<PrivacyNotice[]> {
  const res = await sql<Record<string, unknown>>`
    select distinct on (locale) version, locale, body_md, published_at, sha256
      from serving.privacy_notice
     where published_at <= ${now}
     order by locale, published_at desc, version desc`.execute(tx ?? db('read current privacy notices'));
  return res.rows.map(mapNotice);
}

export async function listNotices(tx?: Db): Promise<Array<Omit<PrivacyNotice, 'bodyMd'>>> {
  const rows = (await (tx ?? db('list privacy notices'))
    .selectFrom('serving.privacy_notice')
    .select(['version', 'locale', 'published_at', 'sha256'])
    .orderBy('published_at', 'desc')
    .execute()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    version: String(r.version),
    locale: r.locale as NoticeLocale,
    publishedAt: toDate(r.published_at),
    sha256: String(r.sha256),
  }));
}

// ---- ledger --------------------------------------------------------------------------------

/**
 * Serialises consent changes per account for the rest of the caller's transaction, so two
 * concurrent requests cannot both decide from the same stale state.
 * Returns false when the account does not exist.
 */
export async function lockAccount(tx: Db, accountId: string): Promise<boolean> {
  const res = await sql<{ id: string }>`select id from serving.account where id = ${accountId} for update`.execute(tx);
  return res.rows.length === 1;
}

export async function listEvents(accountId: string, tx?: Db): Promise<ConsentEvent[]> {
  const rows = (await (tx ?? db('read consent ledger'))
    .selectFrom('serving.consent_event')
    .selectAll()
    .where('account_id', '=', accountId)
    .orderBy('at', 'asc')
    .orderBy('id', 'asc')
    .execute()) as Array<Record<string, unknown>>;
  return rows.map(mapEvent);
}

export async function insertEvents(tx: Db, rows: ReadonlyArray<ConsentEvent>): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insertInto('serving.consent_event')
    .values(
      rows.map((e) => ({
        id: e.id,
        account_id: e.accountId,
        member_id: e.memberId,
        purpose: e.purpose,
        action: e.action,
        notice_version: e.noticeVersion,
        channel: e.channel,
        ip: e.ip,
        at: e.at,
      })),
    )
    .execute();
}

/** IF-38a erase: nulls personal fields (the IP address) while keeping proof of consent. */
export async function minimiseAccountLedger(accountId: string): Promise<number> {
  const res = await sql<{ n: number | string }>`select serving.consent_minimise_account(${accountId}::uuid) as n`.execute(
    db('data rights: minimise consent ledger'),
  );
  return Number(res.rows[0]?.n ?? 0);
}

export function ledgerDb(reason: string): Db {
  return db(reason);
}
