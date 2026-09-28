/**
 * M37 — HTTP routes over IF-37a. Every route is public (no `assertAllowed`/entitlement check):
 * Learn, glossary, scam guide, checklist, promise/coverage/refund/pricing pages are the
 * acquisition-funnel and compliance pages, readable by anonymous visitors.
 *   GET /api/content/pages/:section              → getPage(locale, section)            (index.md)
 *   GET /api/content/pages/:section/:slug         → getPage(locale, "section/slug")
 *   GET /api/content/sections/:section            → listBySection(locale, section)
 *   GET /api/content/hs-chapter/:chapter          → byHsChapter(locale, chapter)
 *   GET /api/content/glossary                     → glossaryTerms(locale)
 *   GET /api/content/strings/:key                 → { value: string(locale, key, query) }
 *
 * The app type is structural (as in M05/M13/M28), so a FastifyInstance satisfies it.
 */
import { AppError, log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { byHsChapter, getPage, glossaryTerms, listBySection, string as contentString } from './service.js';
import { isContentSection } from './types.js';

export interface ContentRouteRequest extends HttpRequestLike {
  params?: unknown;
  query?: unknown;
}

export interface ContentRouteReply extends HttpReplyLike {
  code(status: number): ContentRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: ContentRouteRequest, reply: ContentRouteReply) => Promise<unknown>;

export interface ContentRouteApp {
  get(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: ContentRouteRequest, ctx: ActorContext) => Promise<unknown>;

function record(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = val;
  }
  return out;
}

function localeOf(req: ContentRouteRequest): string {
  const q = record(req.query);
  const locale = q.locale;
  return typeof locale === 'string' && locale.trim() !== '' ? locale.trim() : 'en';
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
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'm37 content route failed');
      applySessionCookies(req, reply);
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

export function registerContentRoutes(app: ContentRouteApp): void {
  app.get(
    '/api/content/pages/:section',
    wrap('content.page.index', async (req) => {
      const p = record(req.params);
      const section = p.section;
      if (typeof section !== 'string') throw new AppError('VALIDATION', 'section is required', { field: 'section' });
      const page = getPage(localeOf(req), section);
      if (!page) throw new AppError('NOT_FOUND', `Page "${section}" not found`, { section });
      return page;
    }),
  );

  app.get(
    '/api/content/pages/:section/:slug',
    wrap('content.page.leaf', async (req) => {
      const p = record(req.params);
      const section = p.section;
      const slug = p.slug;
      if (typeof section !== 'string' || typeof slug !== 'string') {
        throw new AppError('VALIDATION', 'section and slug are required', { fields: ['section', 'slug'] });
      }
      const page = getPage(localeOf(req), `${section}/${slug}`);
      if (!page) throw new AppError('NOT_FOUND', `Page "${section}/${slug}" not found`, { section, slug });
      return page;
    }),
  );

  app.get(
    '/api/content/sections/:section',
    wrap('content.section', async (req) => {
      const p = record(req.params);
      const section = p.section;
      if (typeof section !== 'string' || !isContentSection(section)) {
        throw new AppError('VALIDATION', 'section is not a known content section', { field: 'section' });
      }
      return { items: listBySection(localeOf(req), section) };
    }),
  );

  app.get(
    '/api/content/hs-chapter/:chapter',
    wrap('content.hsChapter', async (req) => {
      const p = record(req.params);
      const chapter = p.chapter;
      if (typeof chapter !== 'string') throw new AppError('VALIDATION', 'chapter is required', { field: 'chapter' });
      return { items: byHsChapter(localeOf(req), chapter) };
    }),
  );

  app.get(
    '/api/content/glossary',
    wrap('content.glossary', async (req) => ({ items: glossaryTerms(localeOf(req)) })),
  );

  app.get(
    '/api/content/strings/:key',
    wrap('content.string', async (req) => {
      const p = record(req.params);
      const key = p.key;
      if (typeof key !== 'string') throw new AppError('VALIDATION', 'key is required', { field: 'key' });
      const q = record(req.query);
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(q)) {
        if (k === 'locale') continue;
        if (typeof v === 'string' || typeof v === 'number') params[k] = v;
      }
      return { value: contentString(localeOf(req), key, Object.keys(params).length > 0 ? params : undefined) };
    }),
  );
}
