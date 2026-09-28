/**
 * M31 — public HTTP routes (IF-31a).
 *   POST /api/public/removal        {requesterEmail, kind, identifiers, details?, turnstileToken} -> 202
 *   GET  /api/public/removal/verify ?token=                                                        -> 200
 *
 * No session is required (LLD M31: "A no-login public form"); `resolveSession` still runs so the
 * anonymous-guard rate limiting (IF-05c) has a context to key on, same as every other public
 * route (M13, M28's public price endpoint, etc). The app type is structural, as in M05/M11/M30.
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { requestRemoval, verifyRemoval } from './service.js';

export interface RemovalRouteRequest extends HttpRequestLike {
  body?: unknown;
  query?: unknown;
}

export interface RemovalRouteReply extends HttpReplyLike {
  code(status: number): RemovalRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: RemovalRouteRequest, reply: RemovalRouteReply) => Promise<unknown>;

export interface RemovalRouteApp {
  post(path: string, handler: RouteHandler): unknown;
  get(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: RemovalRouteRequest, ctx: ActorContext) => Promise<{ status: number; body?: unknown }>;

function wrap(name: string, fn: Handler): RouteHandler {
  return async (req, reply) => {
    let correlationId: string | undefined;
    try {
      const ctx = await resolveSession(req);
      correlationId = ctx.correlationId;
      const { status, body } = await fn(req, ctx);
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      reply.code(status);
      return body === undefined ? reply.send() : reply.send(body);
    } catch (e) {
      const err = toAppError(e, correlationId);
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'removal route failed');
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

function queryParam(req: RemovalRouteRequest, name: string): unknown {
  const q = req.query;
  if (q && typeof q === 'object' && name in q) {
    const v = (q as Record<string, unknown>)[name];
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

export function registerRemovalRoutes(app: RemovalRouteApp): void {
  app.post(
    '/api/public/removal',
    wrap('removal.request', async (req, ctx) => {
      const body = await requestRemoval(ctx, req, req.body);
      return { status: 202, body };
    }),
  );

  app.get(
    '/api/public/removal/verify',
    wrap('removal.verify', async (req, ctx) => {
      const body = await verifyRemoval(ctx, queryParam(req, 'token'));
      return { status: 200, body };
    }),
  );
}
