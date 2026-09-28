/**
 * M42 — HTTP route (LLD M42 API): POST /api/drafts/:parentId/follow-up -> SSE, the same wire
 * format as M34's own POST /api/drafts (data:{delta} … event:footer data:{footer} event:done
 * data:{draftId}). The plumbing here mirrors M34's routes.ts exactly (see that file's own header)
 * because M34 exports no reusable SSE route-handler helper, only its own registered routes.
 *
 * PATCH /api/drafts/:id and POST /api/drafts/:id/handoff are M34's own endpoints, reused as-is for
 * follow-up drafts (neither route branches on `kind` — see M34's routes.ts/service.ts); this
 * module registers no patch/handoff route of its own.
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import type { DraftStreamEvent } from '../m34_draft/index.js';
import { streamFollowUpDraftGeneration } from './service.js';

export interface FollowUpRouteRequest extends HttpRequestLike {
  body?: unknown;
  params?: unknown;
}

/** The subset of Fastify's raw `http.ServerResponse` this module needs. */
export interface FollowUpRawResponseLike {
  writeHead(statusCode: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}

export interface FollowUpRouteReply extends HttpReplyLike {
  code(status: number): FollowUpRouteReply;
  send(payload?: unknown): unknown;
  raw: FollowUpRawResponseLike;
}

type RouteHandler = (req: FollowUpRouteRequest, reply: FollowUpRouteReply) => Promise<unknown>;

export interface FollowUpRouteApp {
  post(path: string, handler: RouteHandler): unknown;
}

function param(req: FollowUpRouteRequest, name: string): unknown {
  const p = req.params;
  if (p && typeof p === 'object' && name in p) return (p as Record<string, unknown>)[name];
  return undefined;
}

function sseFrame(event: string | undefined, data: unknown): string {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  return event ? `event: ${event}\n${payload}` : payload;
}

/**
 * POST /api/drafts/:parentId/follow-up. Validation, the max-2-follow-ups rule, the reply-status
 * gate, the M10/M17 policy and sanctions gate, and the business-profile completeness check all run
 * inside `streamFollowUpDraftGeneration` *before* its first `yield` (mirrors M34's own
 * handleCreateDraft), so a request that fails any of them never opens the SSE stream — it gets a
 * normal JSON error response with the right status code. Once generation has actually started,
 * this switches to `text/event-stream`; the draft is still stored once the stream ends even if the
 * client disconnects, because the generator is drained to completion regardless of write failures.
 */
async function handleCreateFollowUp(req: FollowUpRouteRequest, reply: FollowUpRouteReply): Promise<unknown> {
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

  const gen = streamFollowUpDraftGeneration(ctx, param(req, 'parentId'), req.body);
  let current: IteratorResult<DraftStreamEvent, void>;
  try {
    current = await gen.next();
  } catch (e) {
    const err = toAppError(e, correlationId);
    if (err.code === 'INTERNAL') {
      log.error({ err, route: 'drafts.follow_up', correlationId }, 'follow-up draft generation failed before streaming');
    }
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
      log.warn({ err, correlationId }, 'm42: SSE write failed (client likely gone); follow-up draft generation continues');
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
    log.error({ err: e, correlationId }, 'm42: follow-up draft stream failed mid-generation');
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

export function registerFollowUpRoutes(app: FollowUpRouteApp): void {
  app.post('/api/drafts/:parentId/follow-up', handleCreateFollowUp);
}
