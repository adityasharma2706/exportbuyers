/**
 * M06 — HTTP routes.
 *   GET  /api/privacy-notice?locale=en|hi         → 200 {version, locale, bodyMd, publishedAt, sha256}
 *   GET  /api/consent                             → 200 {consent, reaccept}
 *   POST /api/consent {purposes[], noticeVersion} → 204   (signup consent capture and re-accept)
 *   POST /api/consent/withdraw {purpose, confirm?} → 204  (core_service needs confirm: true)
 *   GET  /api/privacy-notice/:version             → 200 notice (the text a user accepted)
 *   GET  /api/admin/privacy-notices               → 200 {notices: [...]} (no bodies)
 *   POST /api/admin/privacy-notices {version, locale, bodyMd, publishedAt?} → 201
 *
 * Idempotency (LLD §0.3 rule 2): consent writes are idempotent by state — a repeated grant
 * against the same notice or a repeated withdraw appends nothing — so an Idempotency-Key
 * header is accepted and a replay returns the same 204. Publishing a version twice is a
 * CONFLICT because notice versions are immutable.
 *
 * Structural app type, as in M05, so a FastifyInstance satisfies it.
 */
import { AppError, log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, requireMember, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import {
  currentConsent,
  currentNotice,
  getPrivacyNotice,
  listPrivacyNotices,
  publishNotice,
  reacceptStatus,
  recordConsent,
  withdrawConsent,
} from './consent.js';
import { isNoticeLocale, parseNoticeVersion, parsePurpose, parsePurposes } from './ledger.js';
import type { NoticeLocale } from './types.js';

export interface ConsentRouteRequest extends HttpRequestLike {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

export interface ConsentRouteReply extends HttpReplyLike {
  code(status: number): ConsentRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: ConsentRouteRequest, reply: ConsentRouteReply) => Promise<unknown>;

export interface ConsentRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: ConsentRouteRequest, ctx: ActorContext) => Promise<{ status: number; body?: unknown }>;

function wrap(name: string, fn: Handler): RouteHandler {
  return async (req, reply) => {
    let correlationId: string | undefined;
    try {
      const ctx = await resolveSession(req);
      correlationId = ctx.correlationId;
      const out = await fn(req, ctx);
      applySessionCookies(req, reply);
      reply.code(out.status);
      return out.body === undefined ? reply.send() : reply.send(out.body);
    } catch (e) {
      const err = toAppError(e, correlationId);
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'consent route failed');
      applySessionCookies(req, reply);
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

function objectBody(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new AppError('VALIDATION', 'Request body must be a JSON object');
  return v as Record<string, unknown>;
}

function queryLocale(req: ConsentRouteRequest, ctx: ActorContext): NoticeLocale {
  const q = req.query && typeof req.query === 'object' ? (req.query as Record<string, unknown>) : {};
  if (q.locale === undefined) return ctx.locale;
  if (!isNoticeLocale(q.locale)) throw new AppError('VALIDATION', 'Unsupported locale', { field: 'locale' });
  return q.locale;
}

export function registerConsentRoutes(app: ConsentRouteApp): void {
  app.get(
    '/api/privacy-notice',
    wrap('privacy-notice.get', async (req, ctx) => {
      const n = await currentNotice(queryLocale(req, ctx));
      return {
        status: 200,
        body: { version: n.version, locale: n.locale, bodyMd: n.bodyMd, publishedAt: n.publishedAt.toISOString(), sha256: n.sha256 },
      };
    }),
  );

  app.get(
    '/api/privacy-notice/:version',
    wrap('privacy-notice.version', async (req) => {
      const p = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {};
      const n = await getPrivacyNotice(parseNoticeVersion(p.version));
      return {
        status: 200,
        body: { version: n.version, locale: n.locale, bodyMd: n.bodyMd, publishedAt: n.publishedAt.toISOString(), sha256: n.sha256 },
      };
    }),
  );

  app.get(
    '/api/admin/privacy-notices',
    wrap('privacy-notice.list', async (_req, ctx) => {
      const notices = await listPrivacyNotices(ctx);
      return {
        status: 200,
        body: {
          notices: notices.map((n) => ({
            version: n.version,
            locale: n.locale,
            publishedAt: n.publishedAt.toISOString(),
            sha256: n.sha256,
          })),
        },
      };
    }),
  );

  app.get(
    '/api/consent',
    wrap('consent.get', async (_req, ctx) => {
      const { accountId } = requireMember(ctx);
      const [state, reaccept] = await Promise.all([currentConsent(accountId), reacceptStatus(accountId, ctx.locale)]);
      const consent: Record<string, { granted: boolean; at: string; noticeVersion: string }> = {};
      for (const [purpose, s] of Object.entries(state)) {
        if (s) consent[purpose] = { granted: s.granted, at: s.at.toISOString(), noticeVersion: s.noticeVersion };
      }
      return { status: 200, body: { consent, reaccept } };
    }),
  );

  app.post(
    '/api/consent',
    wrap('consent.record', async (req, ctx) => {
      const b = objectBody(req.body);
      await recordConsent(ctx, parsePurposes(b.purposes), parseNoticeVersion(b.noticeVersion), { channel: 'web' });
      return { status: 204 };
    }),
  );

  app.post(
    '/api/consent/withdraw',
    wrap('consent.withdraw', async (req, ctx) => {
      const b = objectBody(req.body);
      const purpose = parsePurpose(b.purpose);
      // Withdrawing core_service starts account deletion (M38), so it must be confirmed.
      if (purpose === 'core_service' && b.confirm !== true) {
        throw new AppError('VALIDATION', 'Withdrawing core_service deletes your account; confirm to continue', {
          field: 'confirm',
          confirmRequired: true,
        });
      }
      await withdrawConsent(ctx, purpose, { channel: 'web' });
      return { status: 204 };
    }),
  );

  app.post(
    '/api/admin/privacy-notices',
    wrap('privacy-notice.publish', async (req, ctx) => {
      const b = objectBody(req.body);
      let publishedAt: Date | undefined;
      if (b.publishedAt !== undefined) {
        publishedAt = typeof b.publishedAt === 'string' ? new Date(b.publishedAt) : new Date(NaN);
      }
      const n = await publishNotice(ctx, {
        version: parseNoticeVersion(b.version),
        locale: b.locale as NoticeLocale,
        bodyMd: typeof b.bodyMd === 'string' ? b.bodyMd : '',
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      });
      return { status: 201, body: { version: n.version, locale: n.locale, publishedAt: n.publishedAt.toISOString(), sha256: n.sha256 } };
    }),
  );
}
