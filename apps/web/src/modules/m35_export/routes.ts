/**
 * M35 — HTTP routes (IF-35a).
 *   POST /api/exports      {source, format} -> 202 {exportId}
 *   GET  /api/exports/:id                   -> 200 {state, rows?, downloadUrl?, expiresAt}
 *
 * The app type is structural (as in M05/M26/M29/M33), so a FastifyInstance satisfies it.
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { createExport, getExport } from './service.js';

export interface ExportRouteRequest extends HttpRequestLike {
  body?: unknown;
  params?: unknown;
}

export interface ExportRouteReply extends HttpReplyLike {
  code(status: number): ExportRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: ExportRouteRequest, reply: ExportRouteReply) => Promise<unknown>;

export interface ExportRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: ExportRouteRequest, ctx: ActorContext) => Promise<{ status: number; body: unknown }>;

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
      return reply.send(body);
    } catch (e) {
      const err = toAppError(e, correlationId);
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'export route failed');
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

function paramId(req: ExportRouteRequest): unknown {
  const p = req.params;
  if (p && typeof p === 'object' && 'id' in p) return (p as { id: unknown }).id;
  return undefined;
}

export function registerExportRoutes(app: ExportRouteApp): void {
  app.post(
    '/api/exports',
    wrap('exports.create', async (req, ctx) => ({ status: 202, body: await createExport(ctx, req.body) })),
  );

  app.get(
    '/api/exports/:id',
    wrap('exports.get', async (req, ctx) => ({ status: 200, body: await getExport(ctx, paramId(req)) })),
  );
}
