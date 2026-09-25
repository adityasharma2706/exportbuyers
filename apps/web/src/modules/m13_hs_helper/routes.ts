/**
 * M13 — HTTP routes (IF-13a).
 *   POST /api/hs/suggest {text}              → 200 {candidates, disclaimerKey, degraded}
 *   GET  /api/hs/browse?parent=&version=     → 200 {version, parent, nodes}
 *   GET  /api/hs/code/:code?version=         → 200 code detail | 404 NOT_FOUND
 *   POST /api/workspaces/:id/hs {code, version}  (signed in)  → 200 {hs, persisted}
 *   POST /api/anon/hs {code, version}            (anonymous)  → 200 {hs, persisted}
 *
 * Anonymous visitors may use suggest, browse and lookup (REQ-004); suggestions — the costly
 * call — go through guardAnonymous(ctx, 'hs'). The app type is structural, so a FastifyInstance
 * satisfies it (as in M05/M07).
 */
import { AppError, log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, guardAnonymous, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { browseHs, codeDetail, saveAnonymousHs, saveWorkspaceHs } from './service.js';
import { suggestHs } from './suggest.js';

export interface HsRouteRequest extends HttpRequestLike {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

export interface HsRouteReply extends HttpReplyLike {
  code(status: number): HsRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: HsRouteRequest, reply: HsRouteReply) => Promise<unknown>;

export interface HsRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: HsRouteRequest, ctx: ActorContext) => Promise<unknown>;

/** Copies a plain object's own entries (request body/query/params) into a fresh record; anything else yields an empty record. */
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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'hs helper route failed');
      applySessionCookies(req, reply);
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

export function registerHsHelperRoutes(app: HsRouteApp): void {
  app.post(
    '/api/hs/suggest',
    wrap('hs.suggest', async (req, ctx) => {
      if (ctx.kind === 'anonymous') await guardAnonymous(ctx, 'hs', req);
      return suggestHs(ctx, record(req.body).text);
    }),
  );

  app.get(
    '/api/hs/browse',
    wrap('hs.browse', async (req) => {
      const q = record(req.query);
      return browseHs(q.parent, q.version);
    }),
  );

  app.get(
    '/api/hs/code/:code',
    wrap('hs.code', async (req) => {
      const p = record(req.params);
      if (typeof p.code !== 'string' || p.code.length === 0) throw new AppError('NOT_FOUND', 'HS code not found');
      return codeDetail(p.code,record(req.query).version);
    }),
  );

  app.post(
    '/api/workspaces/:id/hs',
    wrap('hs.save.workspace', async (req, ctx) => {
      const p = record(req.params);
      if (typeof p.id !== 'string' || p.id.length === 0) throw new AppError('NOT_FOUND', 'Workspace not found');
      return saveWorkspaceHs(ctx, p.id, req.body);
    }),
  );

  app.post(
    '/api/anon/hs',
    wrap('hs.save.anon', async (req, ctx) => saveAnonymousHs(ctx, req.body)),
  );
}
