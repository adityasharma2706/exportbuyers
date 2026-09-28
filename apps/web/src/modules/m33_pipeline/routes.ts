/**
 * M33 — HTTP routes (IF-33a).
 *   POST   /api/workspaces/:ws/shortlist {companyIds}      -> 200 {added, alreadyPresent, denied}
 *   PATCH  /api/shortlist/:id {status?, nextActionAt?}     -> 200 entry
 *   POST   /api/shortlist/:id/notes {body}                 -> 201 note
 *   PATCH  /api/shortlist/:id/notes {noteId, body}          -> 200 note
 *   DELETE /api/shortlist/:id/notes {noteId}                -> 204
 *   GET    /api/workspaces/:ws/shortlist?status             -> 200 {entries}
 *   GET    /api/my-buyers?status&workspaceId                -> 200 {entries}
 *
 * The app type is structural (as in M07/M26/M27/M30), so a FastifyInstance satisfies it.
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { addNote, addToShortlist, editNote, listWorkspaceShortlist, myBuyers, removeNote, updateShortlistStatus } from './service.js';

export interface PipelineRouteRequest extends HttpRequestLike {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

export interface PipelineRouteReply extends HttpReplyLike {
  code(status: number): PipelineRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: PipelineRouteRequest, reply: PipelineRouteReply) => Promise<unknown>;

export interface PipelineRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
  patch(path: string, handler: RouteHandler): unknown;
  delete(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: PipelineRouteRequest, ctx: ActorContext) => Promise<{ status: number; body?: unknown }>;

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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'pipeline route failed');
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

function param(req: PipelineRouteRequest, name: string): unknown {
  const p = req.params;
  if (p && typeof p === 'object' && name in p) return (p as Record<string, unknown>)[name];
  return undefined;
}

function query(req: PipelineRouteRequest, name: string): unknown {
  const q = req.query;
  if (q && typeof q === 'object' && name in q) return (q as Record<string, unknown>)[name];
  return undefined;
}

export function registerPipelineRoutes(app: PipelineRouteApp): void {
  app.post(
    '/api/workspaces/:ws/shortlist',
    wrap('shortlist.add', async (req, ctx) => ({ status: 200, body: await addToShortlist(ctx, param(req, 'ws'), req.body) })),
  );

  app.get(
    '/api/workspaces/:ws/shortlist',
    wrap('shortlist.list', async (req, ctx) => ({
      status: 200,
      body: await listWorkspaceShortlist(ctx, param(req, 'ws'), query(req, 'status')),
    })),
  );

  app.patch(
    '/api/shortlist/:id',
    wrap('shortlist.updateStatus', async (req, ctx) => ({ status: 200, body: await updateShortlistStatus(ctx, param(req, 'id'), req.body) })),
  );

  app.post(
    '/api/shortlist/:id/notes',
    wrap('shortlist.notes.add', async (req, ctx) => ({ status: 201, body: await addNote(ctx, param(req, 'id'), req.body) })),
  );

  app.patch(
    '/api/shortlist/:id/notes',
    wrap('shortlist.notes.edit', async (req, ctx) => ({ status: 200, body: await editNote(ctx, param(req, 'id'), req.body) })),
  );

  app.delete(
    '/api/shortlist/:id/notes',
    wrap('shortlist.notes.remove', async (req, ctx) => {
      await removeNote(ctx, param(req, 'id'), req.body);
      return { status: 204 };
    }),
  );

  app.get(
    '/api/my-buyers',
    wrap('myBuyers', async (req, ctx) => ({ status: 200, body: await myBuyers(ctx, query(req, 'status'), query(req, 'workspaceId')) })),
  );
}
