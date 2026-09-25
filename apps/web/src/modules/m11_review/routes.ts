/**
 * M11 — admin console HTTP API. Every route runs behind M05's requireAdmin (admin role + MFA),
 * then per-type RBAC in the service.
 *
 *   GET  /admin/review?type&state[&mine&limit&offset]  → {items, total, limit, offset, types}
 *   GET  /admin/review/:id                             → {item, type, audit}
 *   POST /admin/review/:id/claim                       → item
 *   POST /admin/review/:id/release                     → item
 *   POST /admin/review/:id/resolve {outcome, data}     → item
 *
 * The app type is structural (a FastifyInstance satisfies it).
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type RouteReply, type RouteRequest } from '../m05_identity/index.js';
import { claimItem, getItem, listItems, releaseItem, resolveItem } from './service.js';

export interface ReviewRouteRequest extends RouteRequest {
  params?: unknown;
  query?: unknown;
}

type RouteHandler = (req: ReviewRouteRequest, reply: RouteReply) => Promise<unknown>;

export interface ReviewRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: ReviewRouteRequest, ctx: ActorContext) => Promise<{ status: number; body?: unknown }>;

function paramId(req: ReviewRouteRequest): unknown {
  const p = req.params;
  if (p && typeof p === 'object' && 'id' in p) return (p as { id: unknown }).id;
  return undefined;
}

function wrap(name: string, fn: Handler): RouteHandler {
  return async (req, reply) => {
    let correlationId: string | undefined;
    try {
      const ctx = await resolveSession(req);
      correlationId = ctx.correlationId;
      const out = await fn(req, ctx);
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      reply.code(out.status);
      return out.body === undefined ? reply.send() : reply.send(out.body);
    } catch (e) {
      const err = toAppError(e, correlationId);
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'review console route failed');
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

export function registerReviewRoutes(app: ReviewRouteApp): void {
  app.get(
    '/admin/review',
    wrap('review.list', async (req, ctx) => ({ status: 200, body: await listItems(ctx, req.query) })),
  );
  app.get(
    '/admin/review/:id',
    wrap('review.get', async (req, ctx) => ({ status: 200, body: await getItem(ctx, paramId(req)) })),
  );
  app.post(
    '/admin/review/:id/claim',
    wrap('review.claim', async (req, ctx) => ({ status: 200, body: await claimItem(ctx, paramId(req)) })),
  );
  app.post(
    '/admin/review/:id/release',
    wrap('review.release', async (req, ctx) => ({ status: 200, body: await releaseItem(ctx, paramId(req)) })),
  );
  app.post(
    '/admin/review/:id/resolve',
    wrap('review.resolve', async (req, ctx) => ({ status: 200, body: await resolveItem(ctx, paramId(req), req.body) })),
  );
}
