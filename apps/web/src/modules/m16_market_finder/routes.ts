/**
 * M16 — HTTP routes (IF-16a).
 *   GET /api/markets?hs=<code>&version=          → 200 MarketsResponse (anonymous: guardAnonymous 'market')
 *   PUT /api/workspaces/:id/countries {countries} → 200 {countries, persisted}   (signed in)
 *   PUT /api/anon/countries {countries}           → 200 {countries, persisted}   (anonymous)
 *
 * The app type is structural, so a FastifyInstance satisfies it (as in M05/M07/M13).
 */
import { AppError, log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, guardAnonymous, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { findMarkets, saveAnonymousCountries, saveWorkspaceCountries } from './service.js';

export interface MarketRouteRequest extends HttpRequestLike {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

export interface MarketRouteReply extends HttpReplyLike {
  code(status: number): MarketRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: MarketRouteRequest, reply: MarketRouteReply) => Promise<unknown>;

export interface MarketRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  put(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: MarketRouteRequest, ctx: ActorContext) => Promise<unknown>;

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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'market finder route failed');
      applySessionCookies(req, reply);
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

export function registerMarketFinderRoutes(app: MarketRouteApp): void {
  app.get(
    '/api/markets',
    wrap('markets.find', async (req, ctx) => {
      if (ctx.kind === 'anonymous') await guardAnonymous(ctx, 'market', req);
      const q = record(req.query);
      return findMarkets(q.hs, q.version);
    }),
  );

  app.put(
    '/api/workspaces/:id/countries',
    wrap('markets.countries.workspace', async (req, ctx) => {
      const p = record(req.params);
      if (typeof p.id !== 'string' || p.id.length === 0) throw new AppError('NOT_FOUND', 'Workspace not found');
      return saveWorkspaceCountries(ctx, p.id, req.body);
    }),
  );

  app.put(
    '/api/anon/countries',
    wrap('markets.countries.anon', async (req, ctx) => saveAnonymousCountries(ctx, req.body)),
  );
}
