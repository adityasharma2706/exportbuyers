/**
 * M26 — HTTP routes (IF-26a).
 *   POST /api/buyers/search                          → BuyerSearchResponseDto
 *   GET  /api/buyers/discovery-status?heading&countries → DiscoveryStatusResponseDto
 *
 * The app type is structural, so a FastifyInstance satisfies it (as in M07/M13/M16).
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, guardAnonymous, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { discoveryStatus, searchBuyers } from './service.js';
import { parseDiscoveryStatusQuery } from './validate.js';

export interface BuyerSearchRouteRequest extends HttpRequestLike {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

export interface BuyerSearchRouteReply extends HttpReplyLike {
  code(status: number): BuyerSearchRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: BuyerSearchRouteRequest, reply: BuyerSearchRouteReply) => Promise<unknown>;

export interface BuyerSearchRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: BuyerSearchRouteRequest, ctx: ActorContext) => Promise<unknown>;

function record(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = val;
  }
  return out;
}

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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'buyer search route failed');
      applySessionCookies(req, reply);
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

export function registerBuyerSearchRoutes(app: BuyerSearchRouteApp): void {
  app.post(
    '/api/buyers/search',
    wrap('buyers.search', async (req, ctx) => {
      if (ctx.kind === 'anonymous') await guardAnonymous(ctx, 'search_preview', req);
      return searchBuyers(ctx, req.body);
    }),
  );

  app.get(
    '/api/buyers/discovery-status',
    wrap('buyers.discoveryStatus', async (req) => {
      const q = record(req.query);
      const { heading, countries } = parseDiscoveryStatusQuery(q.heading, q.countries);
      return discoveryStatus(heading, countries);
    }),
  );
}
