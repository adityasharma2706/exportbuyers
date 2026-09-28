/**
 * M43 — HTTP routes (IF-43a).
 *   POST /api/billing/money-back {reason} -> {reviewItemId, status: 'filed'}
 *
 * The app type is structural (as in M05/M06/M28/M29/M30), so a FastifyInstance satisfies it.
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { requestMoneyBack } from './service.js';

export interface MoneyBackRouteRequest extends HttpRequestLike {
  body?: unknown;
}

export interface MoneyBackRouteReply extends HttpReplyLike {
  code(status: number): MoneyBackRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: MoneyBackRouteRequest, reply: MoneyBackRouteReply) => Promise<unknown>;

export interface MoneyBackRouteApp {
  post(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: MoneyBackRouteRequest, ctx: ActorContext) => Promise<{ status: number; body?: unknown }>;

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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'money-back route failed');
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

function objectBody(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function registerMoneyBackRoutes(app: MoneyBackRouteApp): void {
  app.post(
    '/api/billing/money-back',
    wrap('billing.moneyBack', async (req, ctx) => {
      const body = await requestMoneyBack(ctx, objectBody(req.body));
      return { status: 200, body };
    }),
  );
}
