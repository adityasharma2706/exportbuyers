/**
 * M41 — HTTP routes.
 *   GET   /api/dashboard                              -> 200 IF-41c DashboardDto
 *   GET   /api/notifications?cursor                    -> 200 {items, nextCursor} [addition; see
 *                                                          service.ts's listNotificationsPage doc]
 *   POST  /api/notifications/:id/read                  -> 200 NotificationDto [addition]
 *   GET   /api/notify-prefs                             -> 200 {email, whatsapp} [addition]
 *   PATCH /api/notify-prefs {email?, whatsapp?}          -> 200 {email, whatsapp} [addition]
 *   POST  /api/reminders {entryId, dueAt, kind}          -> 201 ReminderDto [addition; IF-41a is
 *                                                          "lib" per HLD, so this is a thin wrapper
 *                                                          for the web UI rather than the LLD's
 *                                                          own documented surface]
 *   PATCH /api/reminders/:id {until}                    -> 200 ReminderDto (snooze) [addition]
 *   POST  /api/reminders/:id/complete                   -> 200 ReminderDto [addition]
 *
 * The app type is structural (as in M07/M26/M27/M30/M33), so a FastifyInstance satisfies it.
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { complete, createReminder, dashboard, getNotifyPrefs, listNotificationsPage, markRead, setNotifyPrefs, snooze } from './service.js';
import { objectBody } from './validate.js';

export interface NotifyRouteRequest extends HttpRequestLike {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

export interface NotifyRouteReply extends HttpReplyLike {
  code(status: number): NotifyRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: NotifyRouteRequest, reply: NotifyRouteReply) => Promise<unknown>;

export interface NotifyRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
  patch(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: NotifyRouteRequest, ctx: ActorContext) => Promise<{ status: number; body?: unknown }>;

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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'notify route failed');
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

function param(req: NotifyRouteRequest, name: string): unknown {
  const p = req.params;
  if (p && typeof p === 'object' && name in p) return (p as Record<string, unknown>)[name];
  return undefined;
}

function query(req: NotifyRouteRequest, name: string): unknown {
  const q = req.query;
  if (q && typeof q === 'object' && name in q) return (q as Record<string, unknown>)[name];
  return undefined;
}

export function registerNotifyRoutes(app: NotifyRouteApp): void {
  app.get(
    '/api/dashboard',
    wrap('dashboard', async (_req, ctx) => ({ status: 200, body: await dashboard(ctx) })),
  );

  app.get(
    '/api/notifications',
    wrap('notifications.list', async (req, ctx) => ({
      status: 200,
      body: await listNotificationsPage(ctx, query(req, 'cursor'), query(req, 'limit')),
    })),
  );

  app.post(
    '/api/notifications/:id/read',
    wrap('notifications.read', async (req, ctx) => ({ status: 200, body: await markRead(ctx, param(req, 'id')) })),
  );

  app.get(
    '/api/notify-prefs',
    wrap('notifyPrefs.get', async (_req, ctx) => ({ status: 200, body: await getNotifyPrefs(ctx) })),
  );

  app.patch(
    '/api/notify-prefs',
    wrap('notifyPrefs.set', async (req, ctx) => {
      const b = objectBody(req.body);
      return { status: 200, body: await setNotifyPrefs(ctx, b.email, b.whatsapp) };
    }),
  );

  app.post(
    '/api/reminders',
    wrap('reminders.create', async (req, ctx) => {
      const b = objectBody(req.body);
      return { status: 201, body: await createReminder(ctx, b.entryId, b.dueAt, b.kind) };
    }),
  );

  app.patch(
    '/api/reminders/:id',
    wrap('reminders.snooze', async (req, ctx) => {
      const b = objectBody(req.body);
      return { status: 200, body: await snooze(ctx, param(req, 'id'), b.until) };
    }),
  );

  app.post(
    '/api/reminders/:id/complete',
    wrap('reminders.complete', async (req, ctx) => ({ status: 200, body: await complete(ctx, param(req, 'id')) })),
  );
}
