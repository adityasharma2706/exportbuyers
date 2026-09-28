/**
 * M40 — HTTP routes (IF-40a ReconfirmHs).
 *   GET  /api/hs/reconfirm                       (signed in) -> 200 {items: ReconfirmItemDto[]}
 *   POST /api/workspaces/:id/hs/reconfirm {code}  (signed in) -> 200 workspace
 *
 * The app type is structural, so a FastifyInstance satisfies it (as in M05/M07/M13).
 */
import { AppError, log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, requireMember, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import type { Workspace } from '../m07_tenancy/index.js';
import { listReconfirmations, reconfirmWorkspace } from './service.js';

export interface HsReconfirmRouteRequest extends HttpRequestLike {
  body?: unknown;
  params?: unknown;
}

export interface HsReconfirmRouteReply extends HttpReplyLike {
  code(status: number): HsReconfirmRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: HsReconfirmRouteRequest, reply: HsReconfirmRouteReply) => Promise<unknown>;

export interface HsReconfirmRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: HsReconfirmRouteRequest, ctx: ActorContext) => Promise<unknown>;

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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'hs reconfirm route failed');
      applySessionCookies(req, reply);
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

function paramId(req: HsReconfirmRouteRequest): string {
  const p = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {};
  if (typeof p.id !== 'string' || p.id.length === 0) throw new AppError('NOT_FOUND', 'Workspace not found');
  return p.id;
}

export function workspaceHsDto(w: Workspace): Record<string, unknown> {
  return {
    id: w.id,
    name: w.name,
    hs: w.hs,
    hsNeedsReconfirm: w.hsNeedsReconfirm,
    updatedAt: w.updatedAt.toISOString(),
  };
}

export function registerHsReconfirmRoutes(app: HsReconfirmRouteApp): void {
  app.get(
    '/api/hs/reconfirm',
    wrap('hs.reconfirm.list', async (_req, ctx) => {
      requireMember(ctx);
      return { items: await listReconfirmations(ctx) };
    }),
  );

  app.post(
    '/api/workspaces/:id/hs/reconfirm',
    wrap('hs.reconfirm.save', async (req, ctx) => {
      requireMember(ctx);
      const w = await reconfirmWorkspace(ctx, paramId(req), req.body);
      return workspaceHsDto(w);
    }),
  );
}
