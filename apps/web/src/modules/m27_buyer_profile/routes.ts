/**
 * M27 — HTTP routes (IF-27a).
 *   GET /api/buyers/:companyId?workspaceId= → BuyerProfileResponseDto
 *
 * The app type is structural, so a FastifyInstance satisfies it (as in M11/M26).
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { getBuyerProfile } from './service.js';

export interface BuyerProfileRouteRequest extends HttpRequestLike {
  params?: unknown;
  query?: unknown;
}

export interface BuyerProfileRouteReply extends HttpReplyLike {
  code(status: number): BuyerProfileRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: BuyerProfileRouteRequest, reply: BuyerProfileRouteReply) => Promise<unknown>;

export interface BuyerProfileRouteApp {
  get(path: string, handler: RouteHandler): unknown;
}

function paramCompanyId(req: BuyerProfileRouteRequest): unknown {
  const p = req.params;
  if (p && typeof p === 'object' && 'companyId' in p) return (p as { companyId: unknown }).companyId;
  return undefined;
}

function queryWorkspaceId(req: BuyerProfileRouteRequest): unknown {
  const q = req.query;
  if (q && typeof q === 'object' && 'workspaceId' in q) return (q as { workspaceId: unknown }).workspaceId;
  return undefined;
}

type Handler = (req: BuyerProfileRouteRequest, ctx: ActorContext) => Promise<unknown>;

function wrap(name: string, fn: Handler): RouteHandler {
  return async (req, reply) => {
    let correlationId: string | undefined;
    try {
      const ctx = await resolveSession(req);
      correlationId = ctx.correlationId;
      const body = await fn(req, ctx);
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      reply.code(200);
      return reply.send(body);
    } catch (e) {
      const err = toAppError(e, correlationId);
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'buyer profile route failed');
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

export function registerBuyerProfileRoutes(app: BuyerProfileRouteApp): void {
  app.get(
    '/api/buyers/:companyId',
    wrap('buyers.profile', async (req, ctx) => getBuyerProfile(ctx, paramCompanyId(req), queryWorkspaceId(req))),
  );
}
