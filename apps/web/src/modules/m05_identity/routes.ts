/**
 * M05 — HTTP routes (IF-05a):
 *   POST /api/auth/otp/request {channel, destination} → 202 {challengeId, resendAfterSec}
 *   POST /api/auth/otp/verify  {challengeId, code}    → 200 {isNewUser} + Set-Cookie sid
 *   POST /api/auth/logout                             → 204
 *   POST /api/admin/mfa/verify {totp}                 → 204
 *
 * The app type is structural so this module does not depend on Fastify's generics; a
 * FastifyInstance satisfies it.
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { verifyAdminMfa } from './admin.js';
import { requestOtp, verifyOtp } from './otp.js';
import { applySessionCookies, endSession, resolveSession, type HttpReplyLike, type HttpRequestLike } from './session.js';

export interface RouteRequest extends HttpRequestLike {
  body?: unknown;
}

export interface RouteReply extends HttpReplyLike {
  code(status: number): RouteReply;
  send(payload?: unknown): unknown;
}

export interface RouteApp {
  post(path: string, handler: (req: RouteRequest, reply: RouteReply) => Promise<unknown>): unknown;
}

type Handler = (req: RouteRequest, ctx: ActorContext) => Promise<{ status: number; body?: unknown }>;

function wrap(name: string, fn: Handler): (req: RouteRequest, reply: RouteReply) => Promise<unknown> {
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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'identity route failed');
      applySessionCookies(req, reply);
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

export function registerIdentityRoutes(app: RouteApp): void {
  app.post(
    '/api/auth/otp/request',
    wrap('otp.request', async (req) => ({ status: 202, body: await requestOtp(req, req.body) })),
  );
  app.post(
    '/api/auth/otp/verify',
    wrap('otp.verify', async (req, ctx) => ({ status: 200, body: await verifyOtp(req, ctx, req.body) })),
  );
  app.post(
    '/api/auth/logout',
    wrap('logout', async (req, ctx) => {
      await endSession(req, ctx);
      return { status: 204 };
    }),
  );
  app.post(
    '/api/admin/mfa/verify',
    wrap('admin.mfa.verify', async (req, ctx) => {
      await verifyAdminMfa(ctx, req.body);
      return { status: 204 };
    }),
  );
}
