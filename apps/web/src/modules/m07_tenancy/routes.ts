/**
 * M07 — HTTP routes.
 *   POST   /api/onboarding {businessName, city, state, whatTheyMake, exportExperience, iec?, targetMarkets?}
 *                                          → 201 {workspaceId}   (200 {workspaceId} if already onboarded)
 *   GET    /api/profile                    → 200 profile
 *   PATCH  /api/profile {...fields}        → 200 profile
 *   GET    /api/workspaces                 → 200 {workspaces: [...]}
 *   POST   /api/workspaces {name, hs?, countries?}  → 201 workspace
 *   GET    /api/workspaces/:id             → 200 workspace
 *   PATCH  /api/workspaces/:id {name?, countries?}  → 200 workspace
 *   DELETE /api/workspaces/:id             → 204
 *
 * Mutating routes accept an Idempotency-Key header (or body `idempotencyKey`), LLD §0.3.
 * The app type is structural (as in M05/M06) so a FastifyInstance satisfies it.
 */
import { AppError, log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, requireMember, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { idempotencyKeyOf, withIdempotency, type StoredResponse } from './idempotency.js';
import {
  completeOnboarding,
  createWorkspace,
  deleteWorkspace,
  getBusinessProfile,
  getWorkspace,
  listWorkspaces,
  updateBusinessProfile,
  updateWorkspace,
} from './tenancy.js';
import type { BusinessProfile, Workspace } from './types.js';
import { parseOnboarding, parseProfilePatch, parseWorkspaceCreate, parseWorkspacePatch } from './validate.js';

export interface TenancyRouteRequest extends HttpRequestLike {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

export interface TenancyRouteReply extends HttpReplyLike {
  code(status: number): TenancyRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: TenancyRouteRequest, reply: TenancyRouteReply) => Promise<unknown>;

export interface TenancyRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
  patch(path: string, handler: RouteHandler): unknown;
  delete(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: TenancyRouteRequest, ctx: ActorContext) => Promise<StoredResponse>;

function wrap(name: string, fn: Handler): RouteHandler {
  return async (req, reply) => {
    let correlationId: string | undefined;
    try {
      const ctx = await resolveSession(req);
      correlationId = ctx.correlationId;
      const out = await fn(req, ctx);
      applySessionCookies(req, reply);
      reply.code(out.status);
      return out.body === undefined ? reply.send() : reply.send(out.body);
    } catch (e) {
      const err = toAppError(e, correlationId);
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'tenancy route failed');
      applySessionCookies(req, reply);
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

/** Mutating handler: sign-in required, then Idempotency-Key replay. */
function mutating(name: string, route: (req: TenancyRouteRequest) => string, fn: Handler): RouteHandler {
  return wrap(name, async (req, ctx) => {
    requireMember(ctx);
    const key = idempotencyKeyOf(req.headers, req.body);
    return withIdempotency(ctx, key, route(req), req.body ?? null, () => fn(req, ctx));
  });
}

function paramId(req: TenancyRouteRequest): string {
  const p = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {};
  if (typeof p.id !== 'string' || p.id.length === 0) throw new AppError('NOT_FOUND', 'Workspace not found');
  return p.id;
}

export function profileDto(p: BusinessProfile): Record<string, unknown> {
  return {
    businessName: p.businessName,
    city: p.city,
    state: p.state,
    whatTheyMake: p.whatTheyMake,
    exportExperience: p.exportExperience,
    iec: p.iec,
    iecVerified: p.iecVerifiedAt !== null,
    iecVerifiedAt: p.iecVerifiedAt?.toISOString() ?? null,
    targetMarkets: p.targetMarkets,
    senderName: p.senderName,
    senderEmail: p.senderEmail,
    website: p.website,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function workspaceDto(w: Workspace): Record<string, unknown> {
  return {
    id: w.id,
    name: w.name,
    hs: w.hs,
    hsNeedsReconfirm: w.hsNeedsReconfirm,
    countries: w.countries,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export function registerTenancyRoutes(app: TenancyRouteApp): void {
  app.post(
    '/api/onboarding',
    mutating('onboarding', () => 'POST /api/onboarding', async (req, ctx) => {
      const input = parseOnboarding(req.body);
      const r = await completeOnboarding(ctx, input);
      return { status: r.created ? 201 : 200, body: { workspaceId: r.workspaceId } };
    }),
  );

  app.get(
    '/api/profile',
    wrap('profile.get', async (_req, ctx) => {
      requireMember(ctx);
      return { status: 200, body: profileDto(await getBusinessProfile(ctx)) };
    }),
  );

  app.patch(
    '/api/profile',
    mutating('profile.patch', () => 'PATCH /api/profile', async (req, ctx) => {
      const p = await updateBusinessProfile(ctx, parseProfilePatch(req.body));
      return { status: 200, body: profileDto(p) };
    }),
  );

  app.get(
    '/api/workspaces',
    wrap('workspaces.list', async (_req, ctx) => {
      requireMember(ctx);
      const list = await listWorkspaces(ctx);
      return { status: 200, body: { workspaces: list.map(workspaceDto) } };
    }),
  );

  app.post(
    '/api/workspaces',
    mutating('workspaces.create', () => 'POST /api/workspaces', async (req, ctx) => {
      const w = await createWorkspace(ctx, parseWorkspaceCreate(req.body));
      return { status: 201, body: workspaceDto(w) };
    }),
  );

  app.get(
    '/api/workspaces/:id',
    wrap('workspaces.get', async (req, ctx) => {
      requireMember(ctx);
      return { status: 200, body: workspaceDto(await getWorkspace(ctx, paramId(req))) };
    }),
  );

  app.patch(
    '/api/workspaces/:id',
    mutating(
      'workspaces.patch',
      (req) => `PATCH /api/workspaces/${paramId(req)}`,
      async (req, ctx) => {
        const w = await updateWorkspace(ctx, paramId(req), parseWorkspacePatch(req.body));
        return { status: 200, body: workspaceDto(w) };
      },
    ),
  );

  app.delete(
    '/api/workspaces/:id',
    mutating(
      'workspaces.delete',
      (req) => `DELETE /api/workspaces/${paramId(req)}`,
      async (req, ctx) => {
        await deleteWorkspace(ctx, paramId(req));
        return { status: 204 };
      },
    ),
  );
}
