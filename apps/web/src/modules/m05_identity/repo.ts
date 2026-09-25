/**
 * M05 — persistence for accounts, members, OTP challenges and sessions.
 *
 * These tables are read before an actor exists (sign-in, cookie lookup), so M05 uses
 * systemDb() with a logged reason. serving.member is also registered as an account-scoped
 * tenant table so later modules can read it through scoped(ctx).
 */
import { sql } from 'kysely';
import { AppError, newId, registerTenantTable, systemDb, type Db, type Id } from '../m01_platform/index.js';
import type { OtpChannel } from './validate.js';

registerTenantTable('serving.member', 'account');

export type AccountStatus = 'active' | 'deleting' | 'deleted';
export type MemberRole = 'owner' | 'member' | 'consultant';
export type AdminRole = 'admin_support' | 'admin_ops' | 'admin_super';

export interface MemberRow {
  id: Id<'member'>;
  account_id: Id<'account'>;
  phone_e164: string | null;
  email: string | null;
  role: MemberRole;
  is_admin: boolean;
  admin_role: AdminRole | null;
  totp_secret_enc: Buffer | null;
  erased_at: Date | null;
  created_at: Date;
}

export interface SessionRow {
  id: string;
  member_id: Id<'member'> | null;
  anon: boolean;
  anon_state: Record<string, unknown>;
  anon_state_pending: Record<string, unknown> | null;
  mfa_verified: boolean;
  ip: string | null;
  ua_hash: string | null;
  expires_at: Date;
  created_at: Date;
  last_seen_at: Date;
}

export interface SessionWithMember {
  session: SessionRow;
  member: MemberRow | null;
  accountStatus: AccountStatus | null;
}

export interface OtpChallengeRow {
  id: string;
  channel: OtpChannel;
  destination_hash: string;
  code_hash: string;
  attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
  ip: string | null;
  created_at: Date;
}

const db = (reason: string): Db => systemDb(`m05: ${reason}`);

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toDateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : toDate(v);
}

function jsonObj(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (typeof v === 'string') {
    try {
      const p: unknown = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function mapMember(r: Record<string, unknown>): MemberRow {
  return {
    id: r.id as Id<'member'>,
    account_id: r.account_id as Id<'account'>,
    phone_e164: (r.phone_e164 as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    role: r.role as MemberRole,
    is_admin: r.is_admin === true,
    admin_role: (r.admin_role as AdminRole | null) ?? null,
    totp_secret_enc: r.totp_secret_enc ? Buffer.from(r.totp_secret_enc as Uint8Array) : null,
    erased_at: toDateOrNull(r.erased_at),
    created_at: toDate(r.created_at),
  };
}

function mapSession(r: Record<string, unknown>): SessionRow {
  return {
    id: String(r.id),
    member_id: (r.member_id as Id<'member'> | null) ?? null,
    anon: r.anon === true,
    anon_state: jsonObj(r.anon_state),
    anon_state_pending: r.anon_state_pending === null || r.anon_state_pending === undefined ? null : jsonObj(r.anon_state_pending),
    mfa_verified: r.mfa_verified === true,
    ip: (r.ip as string | null) ?? null,
    ua_hash: (r.ua_hash as string | null) ?? null,
    expires_at: toDate(r.expires_at),
    created_at: toDate(r.created_at),
    last_seen_at: toDate(r.last_seen_at),
  };
}

function mapChallenge(r: Record<string, unknown>): OtpChallengeRow {
  return {
    id: String(r.id),
    channel: r.channel as OtpChannel,
    destination_hash: String(r.destination_hash),
    code_hash: String(r.code_hash),
    attempts: Number(r.attempts),
    expires_at: toDate(r.expires_at),
    consumed_at: toDateOrNull(r.consumed_at),
    ip: (r.ip as string | null) ?? null,
    created_at: toDate(r.created_at),
  };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';
}

/** Postgres inet accepts IPv4/IPv6 only; anything else is stored as null. */
function inetOrNull(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const s = ip.replace(/^::ffff:/, '');
  return /^[0-9a-fA-F:.]+$/.test(s) && s.length <= 45 ? s : null;
}

// ---- sessions -----------------------------------------------------------------------------

export async function findSession(id: string, now: Date): Promise<SessionWithMember | undefined> {
  const s = (await db('resolve session')
    .selectFrom('serving.session')
    .selectAll()
    .where('id', '=', id)
    .where('expires_at', '>', now)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  if (!s) return undefined;
  const session = mapSession(s);
  if (!session.member_id) return { session, member: null, accountStatus: null };
  const m = (await db('resolve session member')
    .selectFrom('serving.member as m')
    .innerJoin('serving.account as a', 'a.id', 'm.account_id')
    .selectAll('m')
    .select('a.status as account_status')
    .where('m.id', '=', session.member_id)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  if (!m) return { session, member: null, accountStatus: null };
  return { session, member: mapMember(m), accountStatus: m.account_status as AccountStatus };
}

export interface NewSession {
  id: string;
  memberId: Id<'member'> | null;
  anonState?: Record<string, unknown>;
  anonStatePending?: Record<string, unknown> | null;
  ip: string | null;
  uaHash: string | null;
  expiresAt: Date;
  now: Date;
}

export async function insertSession(s: NewSession, tx?: Db): Promise<void> {
  await (tx ?? db('create session'))
    .insertInto('serving.session')
    .values({
      id: s.id,
      member_id: s.memberId,
      anon: s.memberId === null,
      anon_state: JSON.stringify(s.anonState ?? {}),
      anon_state_pending: s.anonStatePending ? JSON.stringify(s.anonStatePending) : null,
      mfa_verified: false,
      ip: inetOrNull(s.ip),
      ua_hash: s.uaHash,
      expires_at: s.expiresAt,
      created_at: s.now,
      last_seen_at: s.now,
    })
    .execute();
}

export async function touchSession(id: string, now: Date, expiresAt: Date): Promise<void> {
  await db('slide session expiry')
    .updateTable('serving.session')
    .set({ last_seen_at: now, expires_at: expiresAt })
    .where('id', '=', id)
    .execute();
}

export async function deleteSession(id: string, tx?: Db): Promise<void> {
  await (tx ?? db('delete session')).deleteFrom('serving.session').where('id', '=', id).execute();
}

export async function setSessionMfaVerified(id: string, expiresAt: Date): Promise<void> {
  await db('admin mfa verified')
    .updateTable('serving.session')
    .set({ mfa_verified: true, expires_at: expiresAt })
    .where('id', '=', id)
    .execute();
}

/** Stores anonymous work on an anonymous session (M07 writes {hsCode, hsVersion, countries[]}). */
export async function updateAnonState(id: string, state: Record<string, unknown>): Promise<void> {
  await db('update anon state')
    .updateTable('serving.session')
    .set({ anon_state: JSON.stringify(state) })
    .where('id', '=', id)
    .where('anon', '=', true)
    .execute();
}

/** Returns and clears the carried-over anonymous state for a signed-in session (M07). */
export async function takeAnonStatePending(id: string): Promise<Record<string, unknown> | null> {
  const r = (await db('consume anon_state_pending')
    .updateTable('serving.session as s')
    .from('serving.session as prev')
    .set({ anon_state_pending: null })
    .whereRef('prev.id', '=', 's.id')
    .where('s.id', '=', id)
    .where('s.anon_state_pending', 'is not', null)
    .returning('prev.anon_state_pending as pending')
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? jsonObj(r.pending) : null;
}

export async function deleteExpiredSessions(now: Date): Promise<number> {
  const r = await db('purge expired sessions').deleteFrom('serving.session').where('expires_at', '<=', now).executeTakeFirst();
  return Number((r as { numDeletedRows?: bigint }).numDeletedRows ?? 0);
}

// ---- OTP challenges ------------------------------------------------------------------------

export async function insertChallenge(c: {
  id: string;
  channel: OtpChannel;
  destinationHash: string;
  codeHash: string;
  expiresAt: Date;
  ip: string | null;
  now: Date;
}): Promise<void> {
  await db('create otp challenge')
    .insertInto('serving.otp_challenge')
    .values({
      id: c.id,
      channel: c.channel,
      destination_hash: c.destinationHash,
      code_hash: c.codeHash,
      attempts: 0,
      expires_at: c.expiresAt,
      consumed_at: null,
      ip: inetOrNull(c.ip),
      created_at: c.now,
    })
    .execute();
}

export async function getChallenge(id: string): Promise<OtpChallengeRow | undefined> {
  const r = (await db('read otp challenge')
    .selectFrom('serving.otp_challenge')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapChallenge(r) : undefined;
}

/**
 * Atomically counts one verify attempt. Returns the updated row, or undefined when the
 * challenge is already consumed, expired or out of attempts.
 */
export async function countVerifyAttempt(id: string, maxAttempts: number, now: Date): Promise<OtpChallengeRow | undefined> {
  const r = (await db('count otp attempt')
    .updateTable('serving.otp_challenge')
    .set({ attempts: sql`attempts + 1` })
    .where('id', '=', id)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', now)
    .where('attempts', '<', maxAttempts)
    .returningAll()
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? mapChallenge(r) : undefined;
}

/** Marks a challenge used. Returns false if another request consumed it first. */
export async function consumeChallenge(id: string, now: Date): Promise<boolean> {
  const r = await db('consume otp challenge')
    .updateTable('serving.otp_challenge')
    .set({ consumed_at: now })
    .where('id', '=', id)
    .where('consumed_at', 'is', null)
    .executeTakeFirst();
  return Number((r as { numUpdatedRows?: bigint }).numUpdatedRows ?? 0) === 1;
}

export async function deleteExpiredChallenges(before: Date): Promise<number> {
  const r = await db('purge otp challenges').deleteFrom('serving.otp_challenge').where('expires_at', '<', before).executeTakeFirst();
  return Number((r as { numDeletedRows?: bigint }).numDeletedRows ?? 0);
}

// ---- members ------------------------------------------------------------------------------

export async function findMemberByDestination(channel: OtpChannel, dest: string, tx?: Db): Promise<(MemberRow & { accountStatus: AccountStatus }) | undefined> {
  const col = channel === 'sms' ? 'm.phone_e164' : 'm.email';
  const r = (await (tx ?? db('find member by destination'))
    .selectFrom('serving.member as m')
    .innerJoin('serving.account as a', 'a.id', 'm.account_id')
    .selectAll('m')
    .select('a.status as account_status')
    .where(col, '=', dest)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? { ...mapMember(r), accountStatus: r.account_status as AccountStatus } : undefined;
}

export async function getMember(id: string): Promise<(MemberRow & { accountStatus: AccountStatus }) | undefined> {
  const r = (await db('read member')
    .selectFrom('serving.member as m')
    .innerJoin('serving.account as a', 'a.id', 'm.account_id')
    .selectAll('m')
    .select('a.status as account_status')
    .where('m.id', '=', id)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  return r ? { ...mapMember(r), accountStatus: r.account_status as AccountStatus } : undefined;
}

/**
 * Finds the member for a verified destination or creates a new account with an owner
 * member. A concurrent sign-up for the same destination loses the unique race and re-reads.
 */
export async function findOrCreateMember(
  channel: OtpChannel,
  dest: string,
): Promise<{ member: MemberRow; accountStatus: AccountStatus; isNew: boolean }> {
  const existing = await findMemberByDestination(channel, dest);
  if (existing) return { member: existing, accountStatus: existing.accountStatus, isNew: false };
  const accountId = newId<'account'>();
  const memberId = newId<'member'>();
  try {
    await db('sign-up creates account and member')
      .transaction()
      .execute(async (trx: Db) => {
        await trx.insertInto('serving.account').values({ id: accountId, status: 'active' }).execute();
        await trx
          .insertInto('serving.member')
          .values({
            id: memberId,
            account_id: accountId,
            phone_e164: channel === 'sms' ? dest : null,
            email: channel === 'email' ? dest : null,
            role: 'owner',
            is_admin: false,
          })
          .execute();
      });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const again = await findMemberByDestination(channel, dest);
    if (!again) throw new AppError('CONFLICT', 'Sign-up conflicted; please retry', undefined, { cause: e });
    return { member: again, accountStatus: again.accountStatus, isNew: false };
  }
  const created = await getMember(memberId);
  if (!created) throw new AppError('INTERNAL', 'Created member could not be read back');
  return { member: created, accountStatus: created.accountStatus, isNew: true };
}

export async function setTotpSecret(memberId: string, enc: Buffer): Promise<void> {
  const r = await db('provision admin totp')
    .updateTable('serving.member')
    .set({ totp_secret_enc: enc, updated_at: new Date() })
    .where('id', '=', memberId)
    .where('is_admin', '=', true)
    .executeTakeFirst();
  if (Number((r as { numUpdatedRows?: bigint }).numUpdatedRows ?? 0) !== 1) {
    throw new AppError('NOT_FOUND', 'Admin member not found');
  }
}

// ---- data rights (IF-38a) ------------------------------------------------------------------

export async function membersOfAccount(accountId: string): Promise<MemberRow[]> {
  const rows = (await db('data rights: list members')
    .selectFrom('serving.member')
    .selectAll()
    .where('account_id', '=', accountId)
    .execute()) as Array<Record<string, unknown>>;
  return rows.map(mapMember);
}

export async function accountStatus(accountId: string): Promise<AccountStatus | undefined> {
  const r = (await db('data rights: account status')
    .selectFrom('serving.account')
    .select('status')
    .where('id', '=', accountId)
    .executeTakeFirst()) as { status?: AccountStatus } | undefined;
  return r?.status;
}

/** Deletes sessions and nulls identifiers for every member of a closed account. */
export async function eraseAccountIdentity(accountId: string, now: Date): Promise<number> {
  return db('data rights: erase identity')
    .transaction()
    .execute(async (trx: Db) => {
      const ids = ((await trx.selectFrom('serving.member').select('id').where('account_id', '=', accountId).execute()) as Array<{
        id: string;
      }>).map((r) => r.id);
      if (ids.length === 0) return 0;
      await trx.deleteFrom('serving.session').where('member_id', 'in', ids).execute();
      await trx
        .updateTable('serving.member')
        .set({ phone_e164: null, email: null, totp_secret_enc: null, erased_at: now, updated_at: now })
        .where('account_id', '=', accountId)
        .execute();
      return ids.length;
    }) as Promise<number>;
}
