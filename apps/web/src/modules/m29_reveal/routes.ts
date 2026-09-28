/**
 * M29 — HTTP routes (IF-29a).
 *   POST /api/reveal           {companyId, idempotencyKey}                       → 200
 *   POST /api/reveal/bulk      {companyIds, idempotencyKey, confirmedCredits}    → 200
 *   GET  /api/reveal/bulk/:id                                                    → 200
 *
 * The app type is structural (as in M05/M06/M28), so a FastifyInstance satisfies it.
 */
import { AppError, log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { getBulkReveal, reveal, revealBulk } from './service.js';

export interface RevealRouteRequest extends HttpRequestLike {
  body?: unknown;
  params?: unknown;
}

export interface RevealRouteReply extends HttpReplyLike {
  code(status: number): RevealRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: RevealRouteRequest, reply: RevealRouteReply) => Promise<unknown>;

export interface RevealRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: RevealRouteRequest, ctx: ActorContext) => Promise<unknown>;

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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'reveal route failed');
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
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new AppError('VALIDATION', 'Request body must be a JSON object');
  return v as Record<string, unknown>;
}

function paramId(req: RevealRouteRequest): unknown {
  const p = req.params;
  if (p && typeof p === 'object' && 'id' in p) return (p as { id: unknown }).id;
  return undefined;
}

export function registerRevealRoutes(app: RevealRouteApp): void {
  app.post(
    '/api/reveal',
    wrap('reveal.single', async (req, ctx) => {
      const b = objectBody(req.body);
      return reveal(ctx, b.companyId, b.idempotencyKey);
    }),
  );

  app.post(
    '/api/reveal/bulk',
    wrap('reveal.bulk', async (req, ctx) => {
      const b = objectBody(req.body);
      return revealBulk(ctx, b.companyIds, b.idempotencyKey, b.confirmedCredits);
    }),
  );

  app.get(
    '/api/reveal/bulk/:id',
    wrap('reveal.bulk.status', async (req, ctx) => getBulkReveal(ctx, paramId(req))),
  );
}
