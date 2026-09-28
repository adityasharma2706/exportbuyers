/**
 * M30 — HTTP routes (IF-30a).
 *   POST   /api/reports          {companyId, assertionId?, reason, note?}  -> 200
 *   DELETE /api/hides/:kind/:id                                            -> 204
 *
 * The app type is structural (as in M05/M06/M28/M29), so a FastifyInstance satisfies it.
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { createReport, deleteHide } from './service.js';

export interface ReportsRouteRequest extends HttpRequestLike {
  body?: unknown;
  params?: unknown;
}

export interface ReportsRouteReply extends HttpReplyLike {
  code(status: number): ReportsRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: ReportsRouteRequest, reply: ReportsRouteReply) => Promise<unknown>;

export interface ReportsRouteApp {
  post(path: string, handler: RouteHandler): unknown;
  delete(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: ReportsRouteRequest, ctx: ActorContext) => Promise<{ status: number; body?: unknown }>;

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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'reports route failed');
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

function objectBody(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function param(req: ReportsRouteRequest, name: string): unknown {
  const p = req.params;
  if (p && typeof p === 'object' && name in p) return (p as Record<string, unknown>)[name];
  return undefined;
}

export function registerReportsRoutes(app: ReportsRouteApp): void {
  app.post(
    '/api/reports',
    wrap('reports.create', async (req, ctx) => {
      const body = await createReport(ctx, objectBody(req.body));
      return { status: 200, body };
    }),
  );

  app.delete(
    '/api/hides/:kind/:id',
    wrap('reports.deleteHide', async (req, ctx) => {
      await deleteHide(ctx, param(req, 'kind'), param(req, 'id'));
      return { status: 204 };
    }),
  );
}
