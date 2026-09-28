/**
 * M32 — HTTP routes (IF-32a).
 *   POST /api/check -> CheckBuyerResponseDto
 *
 * The app type is structural, so a FastifyInstance satisfies it (as in M26/M28/M29).
 *
 * [deviation: LLD M32's own rules prose says "guardAnonymous('check'), 1 free check per day", but
 * the only anonymous-guard mechanism the LLD defines (M05 IF-05c) has a single per-bucket hourly
 * cap, and M05's own tunable table sets `check` to 3/hour, not 1/day. There is no separate
 * day-scoped anonymous counter anywhere else in the LLD to build a second limiter from, so this
 * calls `guardAnonymous(ctx, 'check', req)` as written — the one concrete mechanism both sections
 * name — and treats "1 free check per day" as the tunable's intent rather than a second, undefined
 * limiter to invent.]
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, guardAnonymous, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { checkBuyer } from './service.js';

export interface CheckBuyerRouteRequest extends HttpRequestLike {
  body?: unknown;
}

export interface CheckBuyerRouteReply extends HttpReplyLike {
  code(status: number): CheckBuyerRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: CheckBuyerRouteRequest, reply: CheckBuyerRouteReply) => Promise<unknown>;

export interface CheckBuyerRouteApp {
  post(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: CheckBuyerRouteRequest, ctx: ActorContext) => Promise<unknown>;

function wrap(name: string, fn: Handler): RouteHandler {
  return async (req, reply) => {
    let correlationId: string | undefined;
    try {
      const ctx = await resolveSession(req);
      correlationId = ctx.correlationId;
      const body = await fn(req, ctx);
      applySessionCookies(req, reply);
      reply.code(200);
      return reply.send(body);
    } catch (e) {
      const err = toAppError(e, correlationId);
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'check-a-buyer route failed');
      applySessionCookies(req, reply);
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

export function registerCheckBuyerRoutes(app: CheckBuyerRouteApp): void {
  app.post(
    '/api/check',
    wrap('check.buyer', async (req, ctx) => {
      if (ctx.kind === 'anonymous') await guardAnonymous(ctx, 'check', req);
      return checkBuyer(ctx, req.body);
    }),
  );
}
