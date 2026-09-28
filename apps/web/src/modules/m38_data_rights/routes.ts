/**
 * M38 — HTTP routes (LLD M38 IF-38b).
 *   POST /api/me/data-export          -> 202 {requestId}
 *   GET  /api/me/data-export/:id      -> 200 DataExportStatusDto
 *   POST /api/me/delete {confirm}     -> 202 {requestId}
 *   GET  /api/me/delete/:id           -> 200 DeleteAccountStatusDto
 *   POST /api/me/consent/withdraw {purpose} -> 204 (an `/api/me/...` alias of M06's own
 *     `/api/consent/withdraw`; both call M06's withdrawConsent(), which is what emits EV-11 and
 *     is what actually starts M38's erase flow (events.ts) — see that file's doc comment. This
 *     route exists only because IF-38b names it under `/api/me/`; M06's own route at
 *     `/api/consent/withdraw` keeps working unchanged and is the one place the confirm-gate for
 *     `core_service` is defined (mirrored here so the two paths behave identically).
 *   GET  /grievance                   -> 200 GrievanceContactDto (from M37, per IF-38b)
 *
 * The app type is structural (as in M05/M06/M35), so a FastifyInstance satisfies it.
 */
import { AppError, log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, requireMember, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { isPurpose, withdrawConsent, type Purpose } from '../m06_consent/index.js';
import { grievanceContact } from '../m37_content/index.js';
import { getAccountDeletionStatus, getDataExportStatus, requestAccountDeletion, requestDataExport } from './service.js';

export interface DataRightsRouteRequest extends HttpRequestLike {
  body?: unknown;
  params?: unknown;
  query?: unknown;
}

export interface DataRightsRouteReply extends HttpReplyLike {
  code(status: number): DataRightsRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: DataRightsRouteRequest, reply: DataRightsRouteReply) => Promise<unknown>;

export interface DataRightsRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: DataRightsRouteRequest, ctx: ActorContext) => Promise<{ status: number; body?: unknown }>;

function wrap(name: string, fn: Handler): RouteHandler {
  return async (req, reply) => {
    let correlationId: string | undefined;
    try {
      const ctx = await resolveSession(req);
      correlationId = ctx.correlationId;
      const out = await fn(req, ctx);
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      reply.code(out.status);
      return out.body === undefined ? reply.send() : reply.send(out.body);
    } catch (e) {
      const err = toAppError(e, correlationId);
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'data rights route failed');
      applySessionCookies(req, reply);
      reply.header('cache-control', 'no-store');
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

function paramId(req: DataRightsRouteRequest): unknown {
  const p = req.params;
  if (p && typeof p === 'object' && 'id' in p) return (p as { id: unknown }).id;
  return undefined;
}

function objectBody(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new AppError('VALIDATION', 'Request body must be a JSON object');
  return v as Record<string, unknown>;
}

function parsePurpose(v: unknown): Purpose {
  if (!isPurpose(v)) throw new AppError('VALIDATION', 'Unknown consent purpose', { field: 'purpose' });
  return v;
}

function queryLocale(req: DataRightsRouteRequest, ctx: ActorContext): string {
  const q = req.query && typeof req.query === 'object' ? (req.query as Record<string, unknown>) : {};
  return typeof q.locale === 'string' && q.locale.trim() ? q.locale : ctx.locale;
}

export function registerDataRightsRoutes(app: DataRightsRouteApp): void {
  app.post(
    '/api/me/data-export',
    wrap('me.data-export.create', async (_req, ctx) => ({ status: 202, body: await requestDataExport(ctx) })),
  );

  app.get(
    '/api/me/data-export/:id',
    wrap('me.data-export.get', async (req, ctx) => ({ status: 200, body: await getDataExportStatus(ctx, paramId(req)) })),
  );

  app.post(
    '/api/me/delete',
    wrap('me.delete.create', async (req, ctx) => ({ status: 202, body: await requestAccountDeletion(ctx, req.body) })),
  );

  app.get(
    '/api/me/delete/:id',
    wrap('me.delete.get', async (req, ctx) => ({ status: 200, body: await getAccountDeletionStatus(ctx, paramId(req)) })),
  );

  app.post(
    '/api/me/consent/withdraw',
    wrap('me.consent.withdraw', async (req, ctx) => {
      requireMember(ctx);
      const b = objectBody(req.body);
      const purpose = parsePurpose(b.purpose);
      // Same gate as M06's own /api/consent/withdraw: withdrawing core_service starts account
      // deletion (via EV-11 -> events.ts), so it must be confirmed explicitly.
      if (purpose === 'core_service' && b.confirm !== true) {
        throw new AppError('VALIDATION', 'Withdrawing core_service deletes your account; confirm to continue', {
          field: 'confirm',
          confirmRequired: true,
        });
      }
      await withdrawConsent(ctx, purpose, { channel: 'web' });
      return { status: 204 };
    }),
  );

  app.get(
    '/grievance',
    wrap('grievance.get', async (req, ctx) => {
      const contact = grievanceContact(queryLocale(req, ctx));
      if (!contact) throw new AppError('NOT_FOUND', 'Grievance officer contact is not configured');
      return { status: 200, body: contact };
    }),
  );
}
