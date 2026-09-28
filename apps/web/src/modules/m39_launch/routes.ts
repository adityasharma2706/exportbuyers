/**
 * M39 — hardened buyer-search routes (LLD M39 #3, #4). Wraps M26's own service functions with
 * the account-level anti-scrape guard (antiScrape.ts) and the "try later" degraded-search flag
 * (degradedSearch.ts), without editing M26's own routes.ts (an earlier module's file).
 *
 * This registers the SAME paths M26's `registerBuyerSearchRoutes` does
 * (`POST /api/buyers/search`, `GET /api/buyers/discovery-status`). The two are alternatives, not
 * additions: whichever composition root wires the HTTP app together should call this module's
 * `registerHardenedBuyerSearchRoutes(app)` in production instead of M26's own
 * `registerBuyerSearchRoutes(app)`, the same way M39's other "launch hardening" pieces harden
 * behaviour that shipped in an earlier phase. [deviation: no such composition root exists yet in
 * this workspace (no module before M39 assembles a Fastify app from the register*Routes
 * functions each module exports) — that wiring is out of scope for a single module and is left
 * for whichever later piece of work adds it, the same gap every register*Routes export before
 * this one already has.]
 */
import { log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, guardAnonymous, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { parseDiscoveryStatusQuery, resolveSearchQuery, searchBuyers, type BuyerSearchResponseDto } from '../m26_buyer_search/index.js';
import { guardAccountSearchPage } from './antiScrape.js';
import { discoveryStatusDetailed, searchDownFlags, type DiscoveryStatusWithDownDto } from './degradedSearch.js';

export interface HardenedRouteRequest extends HttpRequestLike {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

export interface HardenedRouteReply extends HttpReplyLike {
  code(status: number): HardenedRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: HardenedRouteRequest, reply: HardenedRouteReply) => Promise<unknown>;

export interface HardenedBuyerSearchRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: HardenedRouteRequest, ctx: ActorContext) => Promise<unknown>;

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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'm39 hardened search route failed');
      applySessionCookies(req, reply);
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

export interface HardenedBuyerSearchResponseDto extends BuyerSearchResponseDto {
  /** True per requested country when the most recent discovery run there was degraded. */
  searchDown: Record<string, boolean>;
}

export function registerHardenedBuyerSearchRoutes(app: HardenedBuyerSearchRouteApp): void {
  app.post(
    '/api/buyers/search',
    wrap('buyers.search.hardened', async (req, ctx) => {
      if (ctx.kind === 'anonymous') await guardAnonymous(ctx, 'search_preview', req);
      await guardAccountSearchPage(ctx, req);
      // Resolved twice (once here for `heading`, once inside searchBuyers) rather than
      // reimplementing M26's own result assembly — resolveSearchQuery is a pure/cheap parse +
      // default-lookup, not a search call, so the duplication costs nothing material.
      const { query, heading } = await resolveSearchQuery(ctx, req.body);
      const [base, searchDown] = await Promise.all([searchBuyers(ctx, req.body), searchDownFlags(heading, query.countries)]);
      const out: HardenedBuyerSearchResponseDto = { ...base, searchDown };
      return out;
    }),
  );

  app.get(
    '/api/buyers/discovery-status',
    wrap('buyers.discoveryStatus.hardened', async (req) => {
      const q = record(req.query);
      const { heading, countries } = parseDiscoveryStatusQuery(q.heading, q.countries);
      const detailed: Record<string, DiscoveryStatusWithDownDto> = await discoveryStatusDetailed(heading, countries);
      return detailed;
    }),
  );
}
