/**
 * M06 — IF-06a consent API.
 *
 *   recordConsent(ctx, purposes, noticeVersion)  append `grant` rows against a notice version
 *   withdrawConsent(ctx, purpose)                append a `withdraw` row + EV-11 ConsentWithdrawn
 *   currentConsent(accountId)                    latest decision per purpose
 *   consentManagerHook                           no-op now; reserved for a DPDP Consent Manager
 *
 * Rules (LLD M06):
 *  - Signup is blocked until core_service is granted against the CURRENT notice version
 *    (409 CONFLICT, details.subCode = 'CONSENT_REQUIRED') — see assertCoreConsent().
 *  - After a new notice is published, reacceptStatus() reports `required` so the UI shows a
 *    re-accept interstitial on the next login.
 *  - Withdrawing core_service behaves like account deletion: the route demands an explicit
 *    confirmation, and the EV-11 event starts M38's erase flow.
 */
import {
  AppError,
  isUuid,
  log,
  newId,
  type ActorContext,
  type Db,
  type Id,
} from '../m01_platform/index.js';
import { emit, registerEventSchema } from '../m02_queue/index.js';
import { requestMetaOf, requireAdmin, requireMember } from '../m05_identity/index.js';
import {
  consentRequired,
  consentWithdrawnSchema,
  foldConsent,
  inetOrNull,
  isChannel,
  isGranted,
  isNoticeLocale,
  needsWithdraw,
  noticeSha256,
  parseNoticeBody,
  parseNoticeVersion,
  parsePurpose,
  parsePurposes,
  purposesToGrant,
  reacceptStatus as computeReaccept,
} from './ledger.js';
import {
  findCurrentNotice,
  findCurrentNotices,
  getNotice,
  insertEvents,
  insertNotice,
  ledgerDb,
  listEvents,
  listNotices,
  lockAccount,
} from './repo.js';
import {
  CONSENT_WITHDRAWN_EVENT,
  type ConsentChannel,
  type ConsentEvent,
  type ConsentHookEvent,
  type ConsentManagerHook,
  type ConsentWithdrawnPayload,
  type CurrentConsent,
  type NoticeLocale,
  type PrivacyNotice,
  type Purpose,
  type ReacceptStatus,
  type RecordConsentOptions,
} from './types.js';

// ---- EV-11 schema ----------------------------------------------------------------------------

export { consentWithdrawnSchema };
registerEventSchema(CONSENT_WITHDRAWN_EVENT, consentWithdrawnSchema);

// ---- Consent Manager hook --------------------------------------------------------------------

/**
 * Reserved for a future DPDP Consent Manager integration. Empty (no-op) by default; install
 * callbacks with setConsentManagerHook(). Called after the ledger transaction commits.
 */
export const consentManagerHook: ConsentManagerHook = {};

export function setConsentManagerHook(hook: ConsentManagerHook): void {
  delete consentManagerHook.onGrant;
  delete consentManagerHook.onWithdraw;
  if (hook.onGrant) consentManagerHook.onGrant = hook.onGrant;
  if (hook.onWithdraw) consentManagerHook.onWithdraw = hook.onWithdraw;
}

async function notifyHook(rows: ReadonlyArray<ConsentEvent>): Promise<void> {
  for (const r of rows) {
    const fn = r.action === 'grant' ? consentManagerHook.onGrant : consentManagerHook.onWithdraw;
    if (!fn) continue;
    const e: ConsentHookEvent = {
      eventId: r.id,
      accountId: r.accountId,
      memberId: r.memberId,
      purpose: r.purpose,
      action: r.action,
      noticeVersion: r.noticeVersion,
      channel: r.channel,
      at: r.at,
    };
    try {
      await fn.call(consentManagerHook, e);
    } catch (err) {
      // The ledger is the system of record; a hook failure must not undo or block it.
      log.error({ err, consentEventId: r.id, action: r.action, purpose: r.purpose }, 'consent manager hook failed');
    }
  }
}

// ---- helpers ---------------------------------------------------------------------------------

function channelOf(opts: RecordConsentOptions | undefined): ConsentChannel {
  const c = opts?.channel ?? 'web';
  if (!isChannel(c)) throw new AppError('VALIDATION', 'Unknown consent channel', { field: 'channel' });
  return c;
}

function ipOf(ctx: ActorContext, opts: RecordConsentOptions | undefined): string | null {
  if (opts && opts.ip !== undefined) return inetOrNull(opts.ip);
  return inetOrNull(requestMetaOf(ctx)?.ip);
}

function localeOf(ctx: ActorContext): NoticeLocale {
  return isNoticeLocale(ctx.locale) ? ctx.locale : 'en';
}

async function inAccountTx<R>(reason: string, accountId: string, fn: (trx: Db) => Promise<R>): Promise<R> {
  return ledgerDb(reason)
    .transaction()
    .execute(async (trx: Db) => {
      if (!(await lockAccount(trx, accountId))) throw new AppError('NOT_FOUND', 'Account not found');
      return fn(trx);
    }) as Promise<R>;
}

// ---- IF-06a ----------------------------------------------------------------------------------

/**
 * Appends a `grant` row for each purpose not already granted against `noticeVersion`.
 * The version must be the current notice of its locale; an older one is refused with
 * 409 CONSENT_REQUIRED so the client re-fetches and shows the current notice.
 */
export async function recordConsent(
  ctx: ActorContext,
  purposes: Purpose[],
  noticeVersion: string,
  opts?: RecordConsentOptions,
): Promise<void> {
  const { accountId, memberId } = requireMember(ctx);
  const wanted = parsePurposes(purposes);
  const version = parseNoticeVersion(noticeVersion);
  const channel = channelOf(opts);
  const ip = ipOf(ctx, opts);

  const inserted = await inAccountTx('record consent', accountId, async (trx) => {
    const now = new Date();
    const notice = await getNotice(version, trx);
    if (!notice || notice.publishedAt.getTime() > now.getTime()) {
      throw new AppError('VALIDATION', 'Unknown privacy notice version', { field: 'noticeVersion' });
    }
    const current = await findCurrentNotice(notice.locale, now, trx);
    if (!current || current.version !== notice.version) {
      throw consentRequired('The privacy notice has changed; review and accept the current version', {
        noticeVersion: version,
        currentVersion: current?.version ?? null,
      });
    }
    const state = foldConsent(await listEvents(accountId, trx));
    const rows: ConsentEvent[] = purposesToGrant(state, wanted, version).map((purpose) => ({
      id: newId<'consent_event'>(),
      accountId,
      memberId,
      purpose,
      action: 'grant',
      noticeVersion: version,
      channel,
      ip,
      at: now,
    }));
    await insertEvents(trx, rows);
    return rows;
  });

  if (inserted.length > 0) {
    log.info({ accountId, purposes: inserted.map((r) => r.purpose), noticeVersion: version, channel }, 'consent granted');
    await notifyHook(inserted);
  }
}

/**
 * Appends a `withdraw` row and emits EV-11 ConsentWithdrawn{accountId, purpose} in the same
 * transaction. A purpose that is not currently granted is a no-op (no row, no event).
 * The withdrawal is recorded against the current notice of the locale the consent was given in.
 */
export async function withdrawConsent(ctx: ActorContext, purpose: Purpose, opts?: RecordConsentOptions): Promise<void> {
  const { accountId, memberId } = requireMember(ctx);
  const p = parsePurpose(purpose);
  const channel = channelOf(opts);
  const ip = ipOf(ctx, opts);

  const inserted = await inAccountTx('withdraw consent', accountId, async (trx) => {
    const now = new Date();
    const state = foldConsent(await listEvents(accountId, trx));
    if (!needsWithdraw(state, p)) return [] as ConsentEvent[];
    const grantedVersion = state[p]!.noticeVersion;
    const grantedNotice = await getNotice(grantedVersion, trx);
    const current = grantedNotice ? await findCurrentNotice(grantedNotice.locale, now, trx) : undefined;
    const row: ConsentEvent = {
      id: newId<'consent_event'>(),
      accountId,
      memberId,
      purpose: p,
      action: 'withdraw',
      noticeVersion: current?.version ?? grantedVersion,
      channel,
      ip,
      at: now,
    };
    await insertEvents(trx, [row]);
    const payload: ConsentWithdrawnPayload = { v: 1, accountId, purpose: p };
    await emit(trx, CONSENT_WITHDRAWN_EVENT, payload);
    return [row];
  });

  if (inserted.length > 0) {
    log.info({ accountId, purpose: p, channel }, 'consent withdrawn');
    await notifyHook(inserted);
  }
}

/**
 * Latest decision per purpose. Purposes never asked are absent; use hasConsent() or
 * isGranted() to test a purpose.
 */
export async function currentConsent(accountId: Id<'account'> | string): Promise<CurrentConsent> {
  if (!isUuid(accountId)) throw new AppError('VALIDATION', 'accountId must be a uuid');
  return foldConsent(await listEvents(accountId));
}

/** Convenience for consent-dependent senders (M41 marketing email, M50 WhatsApp). */
export async function hasConsent(accountId: Id<'account'> | string, purpose: Purpose): Promise<boolean> {
  return isGranted(await currentConsent(accountId), parsePurpose(purpose));
}

/** The ledger rows for an account, oldest first (proof of consent; used by data export). */
export async function consentHistory(accountId: Id<'account'> | string): Promise<ConsentEvent[]> {
  if (!isUuid(accountId)) throw new AppError('VALIDATION', 'accountId must be a uuid');
  return listEvents(accountId);
}

// ---- notices -----------------------------------------------------------------------------------

/** The current notice for a locale, falling back to English. */
export async function currentNotice(locale: NoticeLocale = 'en', now: Date = new Date()): Promise<PrivacyNotice> {
  const n = (await findCurrentNotice(locale, now)) ?? (locale !== 'en' ? await findCurrentNotice('en', now) : undefined);
  if (!n) {
    log.error({ locale }, 'no privacy notice has been published');
    throw new AppError('INTERNAL', 'No privacy notice has been published');
  }
  return n;
}

export interface PublishNoticeInput {
  version: string;
  locale: NoticeLocale;
  bodyMd: string;
  /** Defaults to now. A future time schedules the notice; it becomes current at that time. */
  publishedAt?: Date;
}

/** Publishes a new notice version (admin_super). Published notices are immutable. */
export async function publishNotice(ctx: ActorContext, input: PublishNoticeInput): Promise<PrivacyNotice> {
  requireAdmin(ctx, 'admin_super');
  const version = parseNoticeVersion(input?.version);
  if (!isNoticeLocale(input.locale)) throw new AppError('VALIDATION', 'Unsupported notice locale', { field: 'locale' });
  const bodyMd = parseNoticeBody(input.bodyMd);
  const publishedAt = input.publishedAt ?? new Date();
  if (!(publishedAt instanceof Date) || !Number.isFinite(publishedAt.getTime())) {
    throw new AppError('VALIDATION', 'publishedAt must be a valid date', { field: 'publishedAt' });
  }
  const notice: PrivacyNotice = { version, locale: input.locale, bodyMd, publishedAt, sha256: noticeSha256(bodyMd) };
  try {
    await insertNotice(notice, ledgerDb('publish privacy notice'));
  } catch (e) {
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505') {
      throw new AppError('CONFLICT', 'That notice version already exists', { version }, { cause: e });
    }
    throw e;
  }
  log.info({ version, locale: notice.locale, publishedAt, sha256: notice.sha256, adminMemberId: ctx.memberId }, 'privacy notice published');
  return notice;
}

/** Every notice version ever published (newest first), without bodies. Admin only. */
export async function listPrivacyNotices(ctx: ActorContext): Promise<Array<Omit<PrivacyNotice, 'bodyMd'>>> {
  requireAdmin(ctx, 'admin_support');
  return listNotices();
}

/** A specific notice version, e.g. to show the text a user originally accepted. */
export async function getPrivacyNotice(version: string): Promise<PrivacyNotice> {
  const n = await getNotice(parseNoticeVersion(version));
  if (!n || n.publishedAt.getTime() > Date.now()) throw new AppError('NOT_FOUND', 'Privacy notice not found');
  return n;
}

// ---- gates -------------------------------------------------------------------------------------

/**
 * Whether the account must (re-)accept the current notice. `currentVersion` is the current
 * notice in the caller's locale; a grant against the current notice of any locale counts.
 */
export async function reacceptStatus(accountId: Id<'account'> | string, locale: NoticeLocale = 'en'): Promise<ReacceptStatus> {
  if (!isUuid(accountId)) throw new AppError('VALIDATION', 'accountId must be a uuid');
  const now = new Date();
  const [state, notices, preferred] = await Promise.all([
    currentConsent(accountId),
    findCurrentNotices(now),
    currentNotice(locale, now),
  ]);
  return computeReaccept(
    state,
    preferred.version,
    notices.map((n) => n.version),
  );
}

/**
 * Signup / onboarding gate: throws 409 CONFLICT (subCode CONSENT_REQUIRED) until core_service
 * is granted against the current notice version.
 */
export async function assertCoreConsent(ctx: ActorContext): Promise<void> {
  const { accountId } = requireMember(ctx);
  const s = await reacceptStatus(accountId, localeOf(ctx));
  if (s.required) {
    throw consentRequired('Accept the privacy notice to continue', {
      currentVersion: s.currentVersion,
      acceptedVersion: s.acceptedVersion,
    });
  }
}
