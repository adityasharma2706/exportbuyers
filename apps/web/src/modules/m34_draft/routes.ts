/**
 * M34 — HTTP routes (LLD M34 API):
 *   POST   /api/drafts {entryId, language, tone}  -> SSE: data:{delta} … event:footer
 *                                                     data:{footer} event:done data:{draftId}
 *   PATCH  /api/drafts/:id {bodyEdited}            -> 200 draft
 *   POST   /api/drafts/:id/handoff {via}            -> 204 (IF-34c, emits EV-09)
 *
 * The app type is structural (as in M07/M26/M27/M30/M33), so a FastifyInstance satisfies it.
 * `raw` on the reply is Fastify's underlying `http.ServerResponse` (`reply.raw`), used directly
 * for the SSE endpoint because `HttpReplyLike`/M33's `wrap()` pattern only ever sends one JSON
 * body per request; this route writes many small chunks over one open response instead.
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { handoffDraft, patchDraft, streamDraftGeneration } from './service.js';
import type { DraftStreamEvent } from './types.js';

export interface DraftRouteRequest extends HttpRequestLike {
  body?: unknown;
  params?: unknown;
}

/** The subset of Fastify's raw `http.ServerResponse` this module needs. */
export interface DraftRawResponseLike {
  writeHead(statusCode: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}

export interface DraftRouteReply extends HttpReplyLike {
  code(status: number): DraftRouteReply;
  send(payload?: unknown): unknown;
  raw: DraftRawResponseLike;
}

type RouteHandler = (req: DraftRouteRequest, reply: DraftRouteReply) => Promise<unknown>;

export interface DraftRouteApp {
  post(path: string, handler: RouteHandler): unknown;
  patch(path: string, handler: RouteHandler): unknown;
}

type JsonHandler = (req: DraftRouteRequest, ctx: ActorContext) => Promise<{ status: number; body?: unknown }>;

/** Same envelope as M33/M07/M27/M30's own `wrap()`: resolves the session, applies its cookies,
 * maps thrown errors to the LLD §0.3 error envelope. */
function wrapJson(name: string, fn: JsonHandler): RouteHandler {
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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'draft route failed');
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

function param(req: DraftRouteRequest, name: string): unknown {
  const p = req.params;
  if (p && typeof p === 'object' && name in p) return (p as Record<string, unknown>)[name];
  return undefined;
}

function sseFrame(event: string | undefined, data: unknown): string {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  return event ? `event: ${event}\n${payload}` : payload;
}

/**
 * POST /api/drafts. Validation, the M10/M17 policy and sanctions gate, the rate limit and the
 * business-profile completeness check (LLD M34 Rules/sequence) all run inside
 * `streamDraftGeneration` *before* its first `yield`, so a request that fails any of them never
 * opens the SSE stream at all — it gets a normal JSON error response with the right status code.
 * Only once generation has actually started does this switch to `text/event-stream`; LLD Rules:
 * "The draft is stored after the stream finishes. If the client disconnects, the draft is stored
 * anyway" — so a write failure here (the client having gone away) never stops the generator from
 * being drained to completion and the draft being stored.
 */
async function handleCreateDraft(req: DraftRouteRequest, reply: DraftRouteReply): Promise<unknown> {
  let correlationId: string | undefined;
  let ctx: ActorContext;
  try {
    ctx = await resolveSession(req);
    correlationId = ctx.correlationId;
  } catch (e) {
    const err = toAppError(e);
    reply.header('cache-control', 'no-store');
    reply.code(err.http);
    return reply.send(err.toResponseBody());
  }

  const gen = streamDraftGeneration(ctx, req.body);
  let current: IteratorResult<DraftStreamEvent, void>;
  try {
    current = await gen.next();
  } catch (e) {
    const err = toAppError(e, correlationId);
    if (err.code === 'INTERNAL') log.error({ err, route: 'drafts.create', correlationId }, 'draft generation failed before streaming');
    applySessionCookies(req, reply);
    reply.header('cache-control', 'no-store');
    const retry = err.details?.retryAfterSec;
    if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
    reply.code(err.http);
    return reply.send(err.toResponseBody());
  }

  applySessionCookies(req, reply);
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const writeEvent = (event: string | undefined, data: unknown): void => {
    try {
      reply.raw.write(sseFrame(event, data));
    } catch (err) {
      log.warn({ err, correlationId }, 'm34: SSE write failed (client likely gone); draft generation continues');
    }
  };

  try {
    while (!current.done) {
      const ev = current.value;
      if (ev.type === 'delta') writeEvent(undefined, { delta: ev.delta });
      else if (ev.type === 'footer') writeEvent('footer', { footer: ev.footer });
      else writeEvent('done', { draftId: ev.draftId });
      current = await gen.next();
    }
  } catch (e) {
    log.error({ err: e, correlationId }, 'm34: draft stream failed mid-generation');
    writeEvent('error', toAppError(e, correlationId).toResponseBody().error);
  } finally {
    try {
      reply.raw.end();
    } catch {
      /* connection already closed */
    }
  }
  return undefined;
}

export function registerDraftRoutes(app: DraftRouteApp): void {
  app.post('/api/drafts', handleCreateDraft);

  app.patch(
    '/api/drafts/:id',
    wrapJson('drafts.patch', async (req, ctx) => ({ status: 200, body: await patchDraft(ctx, param(req, 'id'), req.body) })),
  );

  app.post(
    '/api/drafts/:id/handoff',
    wrapJson('drafts.handoff', async (req, ctx) => {
      await handoffDraft(ctx, param(req, 'id'), req.body);
      return { status: 204 };
    }),
  );
}
