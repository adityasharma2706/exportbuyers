/**
 * M05 — sessions and ActorContext resolution (IF-05b).
 *
 * Cookies:
 *   sid  256-bit random token; the DB stores only sha256(token). HttpOnly, Secure, SameSite=Lax.
 *        Users: 30-day sliding expiry. Admins: 12 hours, not extended.
 *   did  signed first-party device id used by the anonymous guard (IF-05c).
 *
 * resolveSession(req) always returns a context: a visitor without a valid session gets a new
 * anonymous session. Cookies to set are collected per request; the HTTP layer writes them
 * with applySessionCookies(req, reply) (routes.ts installs an onSend hook for this).
 */
import {
  AppError,
  currentCorrelationId,
  log,
  newId,
  type ActorContext,
  type ActorRole,
  type Entitlements,
  type Id,
} from '../m01_platform/index.js';
import { identityConfig } from './config.js';
import { isWellFormedToken, keyHash, newDeviceCookie, newSessionToken, sessionIdFromToken, verifyDeviceCookie } from './crypto.js';
import { rateStore } from './rateLimit.js';
import {
  deleteSession,
  findSession,
  insertSession,
  touchSession,
  type AccountStatus,
  type MemberRow,
  type SessionRow,
} from './repo.js';

// ---- HTTP abstraction (structural; Fastify's request/reply satisfy these) -------------------

export interface HttpRequestLike {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string | undefined };
}

export interface HttpReplyLike {
  header(name: string, value: string | string[]): unknown;
}

export interface RequestMeta {
  req: HttpRequestLike;
  ip: string;
  deviceId: string;
  uaHash: string;
  /** sha256 id of the persisted session, or null for an unpersisted (throttled) visitor. */
  sessionId: string | null;
  session: SessionRow | null;
  member: MemberRow | null;
}

const ctxByReq = new WeakMap<object, ActorContext>();
const metaByCtx = new WeakMap<ActorContext, RequestMeta>();
const cookiesByReq = new WeakMap<object, Map<string, string>>();

function header(req: HttpRequestLike, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

export function clientIp(req: HttpRequestLike): string {
  // Fastify's req.ip honours its trustProxy setting; raw X-Forwarded-For is never trusted here.
  const ip = req.ip ?? req.socket?.remoteAddress ?? '';
  return ip.replace(/^::ffff:/, '') || '0.0.0.0';
}

export function parseCookies(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, maxAgeSec: number): string {
  const c = identityConfig().cookies;
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`];
  if (c.secure) parts.push('Secure');
  return parts.join('; ');
}

function queueCookie(req: HttpRequestLike, name: string, value: string, maxAgeSec: number): void {
  let m = cookiesByReq.get(req);
  if (!m) {
    m = new Map();
    cookiesByReq.set(req, m);
  }
  m.set(name, serializeCookie(name, value, maxAgeSec));
}

/** Set-Cookie header values queued for this request. */
export function pendingCookies(req: HttpRequestLike): string[] {
  return [...(cookiesByReq.get(req)?.values() ?? [])];
}

export function applySessionCookies(req: HttpRequestLike, reply: HttpReplyLike): void {
  const list = pendingCookies(req);
  if (list.length > 0) reply.header('set-cookie', list);
}

export function setSessionCookie(req: HttpRequestLike, token: string, maxAgeSec: number): void {
  queueCookie(req, identityConfig().cookies.sessionName, token, maxAgeSec);
}

export function clearSessionCookie(req: HttpRequestLike): void {
  queueCookie(req, identityConfig().cookies.sessionName, '', 0);
}

// ---- entitlements -------------------------------------------------------------------------

export type EntitlementsProvider = (accountId: Id<'account'> | null) => Promise<Entitlements>;

/** LLD M13 rule 7: anonymous search cap 5 [tunable]; nothing else is available anonymously. */
export const ANONYMOUS_ENTITLEMENTS: Readonly<Entitlements> = Object.freeze({
  plan: 'anonymous',
  searchResultCap: 5,
  exportRowsPerMonth: 0,
  bulkRevealMax: 0,
  checksPerMonth: 0,
  revealsIncludedPerMonth: 0,
});

/**
 * Fallback Free entitlements used until M36 registers its provider (M28 owns the real
 * Free defaults in /config/plans.yaml). Conservative on purpose.
 */
export const FALLBACK_FREE_ENTITLEMENTS: Readonly<Entitlements> = Object.freeze({
  plan: 'free',
  searchResultCap: 25,
  exportRowsPerMonth: 0,
  bulkRevealMax: 0,
  checksPerMonth: 3,
  revealsIncludedPerMonth: 0,
});

let entitlementsProvider: EntitlementsProvider | undefined;

export function setEntitlementsProvider(p: EntitlementsProvider | undefined): void {
  entitlementsProvider = p;
}

async function entitlementsFor(accountId: Id<'account'> | null): Promise<Entitlements> {
  if (accountId === null) return { ...ANONYMOUS_ENTITLEMENTS };
  if (!entitlementsProvider) return { ...FALLBACK_FREE_ENTITLEMENTS };
  try {
    return await entitlementsProvider(accountId);
  } catch (err) {
    log.warn({ err, accountId }, 'entitlements provider failed; using Free defaults');
    return { ...FALLBACK_FREE_ENTITLEMENTS };
  }
}

// ---- locale / region ----------------------------------------------------------------------

function localeOf(req: HttpRequestLike, cookies: Record<string, string>): 'en' | 'hi' {
  const c = cookies.NEXT_LOCALE;
  if (c === 'en' || c === 'hi') return c;
  const al = (header(req, 'accept-language') ?? '').toLowerCase();
  const first = al.split(',')[0]?.trim() ?? '';
  return first.startsWith('hi') ? 'hi' : 'en';
}

function regionOf(req: HttpRequestLike): string {
  for (const h of ['cf-ipcountry', 'cloudfront-viewer-country', 'x-vercel-ip-country', 'x-country-code']) {
    const v = header(req, h)?.trim().toUpperCase();
    if (v && /^[A-Z]{2}$/.test(v) && v !== 'XX' && v !== 'T1') return v;
  }
  return 'IN';
}

function correlationOf(req: HttpRequestLike): string {
  const fromCtx = currentCorrelationId();
  if (fromCtx) return fromCtx;
  const h = header(req, 'x-correlation-id') ?? header(req, 'x-request-id');
  if (h && /^[A-Za-z0-9._:-]{8,128}$/.test(h)) return h;
  return newId<'correlation'>();
}

// ---- context construction -----------------------------------------------------------------

export function isAdminSession(member: MemberRow | null): boolean {
  return member?.is_admin === true;
}

function sessionTtlSec(member: MemberRow | null): number {
  const cfg = identityConfig().session;
  return isAdminSession(member) ? cfg.adminTtlSec : cfg.userTtlSec;
}

async function memberContext(
  base: Pick<ActorContext, 'locale' | 'region' | 'correlationId'>,
  member: MemberRow,
  session: SessionRow,
): Promise<ActorContext> {
  const adminActive = member.is_admin && session.mfa_verified && member.admin_role !== null;
  const role: ActorRole = adminActive ? (member.admin_role as ActorRole) : member.role;
  return {
    kind: adminActive ? 'admin' : 'user',
    accountId: member.account_id,
    memberId: member.id,
    role,
    entitlements: await entitlementsFor(member.account_id),
    locale: base.locale,
    region: base.region,
    mfaVerified: session.mfa_verified,
    correlationId: base.correlationId,
  };
}

function anonContext(base: Pick<ActorContext, 'locale' | 'region' | 'correlationId'>, anonSessionId: string): ActorContext {
  return {
    kind: 'anonymous',
    anonSessionId,
    entitlements: { ...ANONYMOUS_ENTITLEMENTS },
    locale: base.locale,
    region: base.region,
    mfaVerified: false,
    correlationId: base.correlationId,
  };
}

function remember(req: HttpRequestLike, ctx: ActorContext, meta: RequestMeta): ActorContext {
  ctxByReq.set(req, ctx);
  metaByCtx.set(ctx, meta);
  return ctx;
}

/** Request details behind a context produced by resolveSession, if still available. */
export function requestMetaOf(ctx: ActorContext): RequestMeta | undefined {
  return metaByCtx.get(ctx);
}

/** Forget the cached context for a request (after sign-in/sign-out within the same request). */
export function forgetRequestContext(req: HttpRequestLike): void {
  ctxByReq.delete(req);
}

async function createAnonymousSession(
  req: HttpRequestLike,
  base: Pick<ActorContext, 'locale' | 'region' | 'correlationId'>,
  meta: Omit<RequestMeta, 'sessionId' | 'session' | 'member'>,
  now: Date,
): Promise<ActorContext> {
  const cfg = identityConfig().session;
  let allowed = true;
  try {
    const r = await rateStore().hit(
      [{ key: `m05:anon-create:${keyHash('ip', meta.ip)}`, limit: cfg.anonCreatePerIpPerHour, windowSec: 3600 }],
      now.getTime(),
      true,
    );
    allowed = r.allowed;
  } catch (err) {
    log.warn({ err }, 'anonymous session creation limiter unavailable; allowing');
  }
  if (!allowed) {
    // Bound DB writes from cookie-less floods: serve an unpersisted anonymous context. The
    // anonymous guard still applies (keyed by IP + device).
    const ctx = anonContext(base, `ephemeral:${meta.deviceId}`);
    return remember(req, ctx, { ...meta, sessionId: null, session: null, member: null });
  }
  const { token, id } = newSessionToken();
  const expiresAt = new Date(now.getTime() + cfg.userTtlSec * 1000);
  await insertSession({ id, memberId: null, ip: meta.ip, uaHash: meta.uaHash, expiresAt, now });
  setSessionCookie(req, token, cfg.userTtlSec);
  const session: SessionRow = {
    id,
    member_id: null,
    anon: true,
    anon_state: {},
    anon_state_pending: null,
    mfa_verified: false,
    ip: meta.ip,
    ua_hash: meta.uaHash,
    expires_at: expiresAt,
    created_at: now,
    last_seen_at: now,
  };
  return remember(req, anonContext(base, id), { ...meta, sessionId: id, session, member: null });
}

async function slide(req: HttpRequestLike, token: string, session: SessionRow, member: MemberRow | null, now: Date): Promise<void> {
  const cfg = identityConfig().session;
  if (now.getTime() - session.last_seen_at.getTime() < cfg.touchIntervalSec * 1000) return;
  let expiresAt: Date;
  if (isAdminSession(member)) {
    // Admin sessions are absolute: 12 h from creation, never extended.
    expiresAt = new Date(Math.min(session.expires_at.getTime(), session.created_at.getTime() + cfg.adminTtlSec * 1000));
  } else {
    expiresAt = new Date(now.getTime() + cfg.userTtlSec * 1000);
  }
  try {
    await touchSession(session.id, now, expiresAt);
    setSessionCookie(req, token, (expiresAt.getTime() - now.getTime()) / 1000);
    session.last_seen_at = now;
    session.expires_at = expiresAt;
  } catch (err) {
    log.warn({ err }, 'session touch failed; continuing with current expiry');
  }
}

/**
 * IF-05b. Resolves the actor for a request. Creates an anonymous session if there is no valid
 * cookie. Idempotent per request object.
 */
export async function resolveSession(req: HttpRequestLike, reply?: HttpReplyLike): Promise<ActorContext> {
  const cached = ctxByReq.get(req);
  if (cached) return cached;
  const ctx = await resolveUncached(req);
  if (reply) applySessionCookies(req, reply);
  return ctx;
}

async function resolveUncached(req: HttpRequestLike): Promise<ActorContext> {
  const now = new Date();
  const cfg = identityConfig();
  const cookies = parseCookies(header(req, 'cookie'));
  const base = { locale: localeOf(req, cookies), region: regionOf(req), correlationId: correlationOf(req) };

  let deviceId = verifyDeviceCookie(cookies[cfg.cookies.deviceName]);
  if (!deviceId) {
    const d = newDeviceCookie();
    deviceId = d.deviceId;
    queueCookie(req, cfg.cookies.deviceName, d.value, cfg.cookies.deviceTtlSec);
  }
  const ip = clientIp(req);
  const uaHash = keyHash('ua', header(req, 'user-agent') ?? '');
  const meta = { req, ip, deviceId, uaHash };

  const token = cookies[cfg.cookies.sessionName];
  if (token && isWellFormedToken(token)) {
    const found = await findSession(sessionIdFromToken(token), now);
    if (found) {
      const { session, member, accountStatus } = found;
      if (session.anon) {
        await slide(req, token, session, null, now);
        return remember(req, anonContext(base, session.id), { ...meta, sessionId: session.id, session, member: null });
      }
      if (member && isUsable(accountStatus, member)) {
        await slide(req, token, session, member, now);
        const ctx = await memberContext(base, member, session);
        return remember(req, ctx, { ...meta, sessionId: session.id, session, member });
      }
      // Member erased or account closing: the session is no longer valid.
      await deleteSession(session.id).catch((err: unknown) => log.warn({ err }, 'failed to delete stale session'));
    }
    clearSessionCookie(req);
  } else if (token) {
    clearSessionCookie(req);
  }
  return createAnonymousSession(req, base, meta, now);
}

function isUsable(status: AccountStatus | null, member: MemberRow): boolean {
  return status === 'active' && member.erased_at === null;
}

/**
 * Starts a signed-in session after OTP verification: the session id rotates (the previous
 * session is deleted) and anonymous work is carried into anon_state_pending for M07.
 */
export async function startMemberSession(req: HttpRequestLike, member: MemberRow, previous: SessionRow | null): Promise<void> {
  const now = new Date();
  const ttl = sessionTtlSec(member);
  const { token, id } = newSessionToken();
  const carried = previous?.anon && Object.keys(previous.anon_state).length > 0 ? previous.anon_state : null;
  await insertSession({
    id,
    memberId: member.id,
    anonStatePending: carried,
    ip: clientIp(req),
    uaHash: keyHash('ua', header(req, 'user-agent') ?? ''),
    expiresAt: new Date(now.getTime() + ttl * 1000),
    now,
  });
  if (previous) {
    await deleteSession(previous.id).catch((err: unknown) => log.warn({ err }, 'failed to delete rotated session'));
  }
  setSessionCookie(req, token, ttl);
  forgetRequestContext(req);
}

/** Ends the current session (logout). */
export async function endSession(req: HttpRequestLike, ctx: ActorContext): Promise<void> {
  const meta = requestMetaOf(ctx);
  if (meta?.sessionId) await deleteSession(meta.sessionId);
  clearSessionCookie(req);
  forgetRequestContext(req);
}

/** Throws UNAUTHENTICATED unless the context is a signed-in member. */
export function requireMember(ctx: ActorContext): { accountId: Id<'account'>; memberId: Id<'member'> } {
  if ((ctx.kind !== 'user' && ctx.kind !== 'admin') || !ctx.accountId || !ctx.memberId) {
    throw new AppError('UNAUTHENTICATED', 'Sign in required');
  }
  return { accountId: ctx.accountId, memberId: ctx.memberId };
}
