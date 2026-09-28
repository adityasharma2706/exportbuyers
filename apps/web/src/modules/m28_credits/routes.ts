/**
 * M28 — HTTP routes.
 *   GET /api/prices                    (public, IF-28c)     → 200 catalogue DTO
 *   GET /api/credits/balance           (signed in)           → 200 {available, held}
 *   GET /api/credits/allowance         (signed in)           → 200 {reveal, check}
 *   GET /api/credits/history?cursor=   (signed in, IF-28's usage-history rule) → 200 {items, nextCursor}
 *
 * The app type is structural (as in M05/M07/M13), so a FastifyInstance satisfies it.
 */
import { AppError, log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, requireMember, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { catalogueDto, getCatalogue } from './catalogue.js';
import { usageHistory } from './history.js';
import { allowanceRemaining, balance } from './ledger.js';

export interface CreditsRouteRequest extends HttpRequestLike {
  query?: unknown;
}

export interface CreditsRouteReply extends HttpReplyLike {
  code(status: number): CreditsRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: CreditsRouteRequest, reply: CreditsRouteReply) => Promise<unknown>;

export interface CreditsRouteApp {
  get(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: CreditsRouteRequest, ctx: ActorContext) => Promise<unknown>;

function record(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = val;
  }
  return out;
}

function wrap(name: string, requireAuth: boolean, fn: Handler): RouteHandler {
  return async (req, reply) => {
    let correlationId: string | undefined;
    try {
      const ctx = await resolveSession(req);
      correlationId = ctx.correlationId;
      if (requireAuth) requireMember(ctx);
      const body = await fn(req, ctx);
      applySessionCookies(req, reply);
      reply.code(200);
      return reply.send(body);
    } catch (e) {
      const err = toAppError(e, correlationId);
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'm28 credits route failed');
      applySessionCookies(req, reply);
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

export function registerCreditsRoutes(app: CreditsRouteApp): void {
  app.get(
    '/api/prices',
    wrap('prices.get', false, async () => catalogueDto(getCatalogue())),
  );

  app.get(
    '/api/credits/balance',
    wrap('credits.balance', true, async (_req, ctx) => balance(ctx)),
  );

  app.get(
    '/api/credits/allowance',
    wrap('credits.allowance', true, async (_req, ctx) => allowanceRemaining(ctx)),
  );

  app.get(
    '/api/credits/history',
    wrap('credits.history', true, async (req, ctx) => {
      const q = record(req.query);
      const cursorRaw = q.cursor;
      if (cursorRaw !== undefined && typeof cursorRaw !== 'string') {
        throw new AppError('VALIDATION', 'cursor must be a string', { field: 'cursor' });
      }
      const cursor = typeof cursorRaw === 'string' && cursorRaw.length > 0 ? cursorRaw : null;
      return usageHistory(ctx, cursor);
    }),
  );
}
