/**
 * M10 — IF-10a, the enforcement library every read path uses: search, profile, reveal, draft,
 * export, notifications, alerts and similar-companies.
 *
 *   search(ctx, surface, q)                      search / export / alert result sets
 *   byIds(ctx, surface, ids, opts?)              decisions + (redacted) profile docs by id
 *   assertAllowed(ctx, surface, companyId, act)  throws POLICY_DENIED / SANCTIONS_BLOCKED / NOT_FOUND
 *   matchByIdentifiers(ctx, {domain?, email?})   catalogue match for M32 (which cannot read anchors)
 */
import { z } from 'zod';
import { AppError, isUuid, log, scoped, withSpan, type ActorContext, type Id } from '../m01_platform/index.js';
import { findSource, listSources, ALL_REGIONS, type SourceEntry } from '../m08_sources/index.js';
import { recordDecisions, type AuditItem } from './audit.js';
import { getCachedSearch, putCachedSearch } from './cache.js';
import { hashNormalised, normaliseDomain, normaliseEmail } from './normalise.js';
import { entitlementsFor, policyConfig, userHidesFor } from './providers.js';
import {
  companyByIdentifierHashes,
  execFromScoped,
  factsForCompanies,
  profileDocs,
  searchDocs,
  type CompanyFacts,
  type Exec,
} from './readModelStore.js';
import { anonymousSearchDoc, redactProfileDoc, redactSearchDoc } from './redact.js';
import { evaluate, permits, type RuleInput } from './rules.js';
import {
  SURFACES,
  type Action,
  type ByIdsEntry,
  type ByIdsOptions,
  type DocFact,
  type PolicyDecision,
  type ProfileDoc,
  type SearchQuery,
  type SearchResult,
  type SearchResultRow,
  type Surface,
} from './types.js';

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const MAX_BY_IDS = 500;

export const searchQuerySchema = z
  .object({
    hsHeadings: z.array(z.string().regex(/^\d{4}$/)).min(1).max(50),
    keyword: z.string().max(200).optional(),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250),
    buyerTypes: z.array(z.string().min(1).max(64)).max(20).optional(),
    activeWithinMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]).optional(),
    minShipments12m: z.number().int().min(0).max(1_000_000).optional(),
    trustLevels: z.array(z.enum(['high', 'medium', 'low', 'unknown'])).max(4).optional(),
    contactTypes: z.array(z.string().min(1).max(32)).max(10).optional(),
    originIndia: z.boolean().optional(),
    originCompetitor: z.boolean().optional(),
    includeLogistics: z.boolean().optional(),
    sort: z.enum(['relevance', 'recency', 'volume', 'trust']),
    page: z.number().int().min(1).max(10_000),
    pageSize: z.union([z.literal(20), z.literal(50)]),
  })
  .strict();

function parseQuery(q: unknown): SearchQuery {
  const r = searchQuerySchema.safeParse(q);
  if (!r.success) throw new AppError('VALIDATION', 'Invalid search query', { issues: r.error.issues });
  return r.data as SearchQuery;
}

function assertSurface(surface: Surface, allowed: readonly Surface[] = SURFACES): void {
  if (!allowed.includes(surface)) throw new AppError('VALIDATION', `Surface "${String(surface)}" is not valid here`);
}

function surfaceAction(surface: Surface): Action {
  switch (surface) {
    case 'reveal':
      return 'reveal';
    case 'draft':
      return 'draft';
    case 'export':
      return 'export';
    case 'notify':
    case 'alert':
      return 'notify';
    default:
      return 'view';
  }
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

function exec(ctx: ActorContext): Exec {
  return execFromScoped(scoped(ctx));
}

async function hasRegionRestrictedSources(): Promise<boolean> {
  try {
    const all = await listSources();
    return all.some((s) => s.status !== 'prohibited' && !s.allowedRegions.includes(ALL_REGIONS));
  } catch (err) {
    log.warn({ err }, 'm10 could not list sources; assuming region restrictions exist');
    return true;
  }
}

async function loadSources(facts: Iterable<DocFact>): Promise<Map<string, SourceEntry | null>> {
  const ids = new Set<string>();
  for (const f of facts) if (typeof f?.source_id === 'string') ids.add(f.source_id);
  const out = new Map<string, SourceEntry | null>();
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        out.set(id, await findSource(id));
      } catch (err) {
        // Unknown licence state: treat as unregistered, which redacts (fail closed).
        log.warn({ err, sourceId: id }, 'm10 source lookup failed');
        out.set(id, null);
      }
    }),
  );
  return out;
}

function factMap(...lists: Array<ReadonlyArray<DocFact> | undefined>): Map<string, DocFact> {
  const m = new Map<string, DocFact>();
  for (const l of lists) for (const f of l ?? []) if (f && typeof f.assertion_id === 'string') m.set(f.assertion_id, f);
  return m;
}

// ---------------------------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------------------------

/**
 * IF-10a search. Rules 1, 5, 6 run in SQL; 2, 3, 4 and 7 per row. On `search` the plan cap
 * applies: rows past `min(total, cap)` are not returned and `limit` is set instead.
 */
export async function search(ctx: ActorContext, surface: 'search' | 'export' | 'alert', query: SearchQuery): Promise<SearchResult> {
  assertSurface(surface, ['search', 'export', 'alert']);
  const q = parseQuery(query);
  const anonymous = ctx.kind === 'anonymous';
  if (anonymous && surface !== 'search') {
    throw new AppError('SIGNUP_REQUIRED', 'Sign up to use this feature', { surface });
  }
  return withSpan('m10.search', async () => {
    const cached = await getCachedSearch(ctx, surface, q);
    if (cached.hit) return cached.hit;

    const [ents, hides] = await Promise.all([entitlementsFor(ctx), userHidesFor(ctx)]);
    const cap = surface === 'search' ? (anonymous ? policyConfig().anonymousSearchCap : Math.max(0, ents.searchResultCap)) : Infinity;
    const offset = (q.page - 1) * q.pageSize;
    const limit = Number.isFinite(cap) ? Math.max(0, Math.min(q.pageSize, cap - offset)) : q.pageSize;

    const db = exec(ctx);
    const { rows, total } = await searchDocs(db, q, [...hides.companies], { offset, limit });

    // Rules 3/4 need the provenance of every displayed field; search docs only carry the
    // heading's facts, so load the rest from the profile docs when it can matter.
    const needFacts = rows.length > 0 && (surface === 'export' || (await hasRegionRestrictedSources()));
    const extra: Map<string, CompanyFacts> = needFacts ? await factsForCompanies(db, rows.map((r) => r.company_id)) : new Map();
    const allFacts: DocFact[] = [];
    for (const r of rows) allFacts.push(...(r.doc.facts ?? []));
    for (const f of extra.values()) allFacts.push(...f.facts);
    const sources = await loadSources(allFacts);

    const out: SearchResultRow[] = [];
    const audit: AuditItem[] = [];
    for (const r of rows) {
      const more = extra.get(r.company_id);
      const input: RuleInput = {
        surface,
        anonymous,
        entitlements: ents,
        suppressed: false, // excluded in SQL
        sanctionsBlock: r.doc.sanctions_block === true,
        closed: false, // closed companies have no search docs
        fieldSources: { ...(more?.fieldSources ?? {}), ...(r.doc.field_sources ?? {}) },
        facts: factMap(more?.facts, r.doc.facts),
        nonExportableAssertionIds: new Set([...(r.doc.non_exportable_assertion_ids ?? []), ...(more?.nonExportable ?? [])]),
        sources,
        region: ctx.region,
        isLogistics: r.doc.is_logistics === true,
        includeLogistics: q.includeLogistics === true,
        userHidden: false, // excluded in SQL
        hiddenAssertionIds: hides.assertions,
      };
      const decision = evaluate(input);
      audit.push({ companyId: r.company_id, decision, denied: !permits(decision, surfaceAction(surface)) });
      if (decision.visibility === 'hidden') continue;
      if (anonymous) {
        const a = anonymousSearchDoc(r.doc);
        out.push({ doc: a.doc, decision, preview: a.preview });
      } else {
        out.push({ doc: redactSearchDoc({ ...r.doc, field_sources: input.fieldSources }, decision), decision });
      }
    }

    const shown = Number.isFinite(cap) ? Math.min(total, cap) : total;
    const result: SearchResult = { rows: out, total, shown };
    if (Number.isFinite(cap) && total > cap) result.limit = { cap, reason: 'PLAN_LIMIT' };

    void recordDecisions(ctx, surface, audit);
    await putCachedSearch(cached.key, result);
    return result;
  }, { surface, anonymous });
}

// ---------------------------------------------------------------------------------------------
// byIds / assertAllowed
// ---------------------------------------------------------------------------------------------

function notFoundDecision(): PolicyDecision {
  return { visibility: 'hidden', allowed: [], redactedFields: [], reasons: [] };
}

/**
 * IF-10a byIds. Returns one entry per requested id (keyed by the requested id, even when it
 * was merged into another company). Hidden companies come back with `doc: null`.
 */
export async function byIds(
  ctx: ActorContext,
  surface: Surface,
  companyIds: ReadonlyArray<Id<'company'> | string>,
  opts: ByIdsOptions = {},
): Promise<Map<Id<'company'>, ByIdsEntry>> {
  assertSurface(surface);
  if (!Array.isArray(companyIds)) throw new AppError('VALIDATION', 'companyIds must be an array');
  const ids = [...new Set(companyIds.map((id) => String(id).toLowerCase()))];
  if (ids.length > MAX_BY_IDS) throw new AppError('VALIDATION', `At most ${MAX_BY_IDS} ids per call`);
  const bad = ids.find((id) => !isUuid(id));
  if (bad !== undefined) throw new AppError('VALIDATION', 'companyIds must be uuids');
  const out = new Map<Id<'company'>, ByIdsEntry>();
  if (ids.length === 0) return out;

  return withSpan('m10.byIds', async () => {
    const anonymous = ctx.kind === 'anonymous';
    const includeLogistics = opts.includeLogistics ?? surface !== 'similar';
    const [ents, hides, rows] = await Promise.all([entitlementsFor(ctx), userHidesFor(ctx), profileDocs(exec(ctx), ids)]);
    const allFacts: DocFact[] = [];
    for (const r of rows) if (r.doc) allFacts.push(...(r.doc.facts ?? []));
    const sources = await loadSources(allFacts);
    const action = surfaceAction(surface);
    const audit: AuditItem[] = [];

    for (const r of rows) {
      const key = r.requestedId as Id<'company'>;
      if (!r.doc || !r.companyId) {
        out.set(key, { doc: null, decision: notFoundDecision() });
        continue;
      }
      const doc = r.doc;
      const decision = evaluate({
        surface,
        anonymous,
        entitlements: ents,
        suppressed: r.suppressed,
        sanctionsBlock: r.sanctionsBlock || doc.sanctions_block === true,
        closed: doc.status === 'closed',
        fieldSources: doc.field_sources ?? {},
        facts: factMap(doc.facts),
        nonExportableAssertionIds: new Set(doc.non_exportable_assertion_ids ?? []),
        sources,
        region: ctx.region,
        isLogistics: r.isLogistics || doc.is_logistics === true,
        includeLogistics,
        userHidden: hides.companies.has(r.companyId) || hides.companies.has(r.requestedId),
        hiddenAssertionIds: hides.assertions,
      });
      audit.push({ companyId: r.companyId, decision, denied: !permits(decision, action) });
      out.set(key, { doc: decision.visibility === 'hidden' ? null : redactProfileDoc(doc, decision), decision });
    }
    void recordDecisions(ctx, surface, audit);
    return out;
  }, { surface, n: ids.length });
}

/**
 * IF-10a assertAllowed. Returns the (redacted) profile doc when `action` is permitted.
 *   - unknown or suppressed company → NOT_FOUND (suppression is never revealed)
 *   - sanctions block on a non-view action → SANCTIONS_BLOCKED
 *   - anything else refused → POLICY_DENIED with details.reasons
 */
export async function assertAllowed(
  ctx: ActorContext,
  surface: Surface,
  companyId: Id<'company'> | string,
  action: Action,
): Promise<ProfileDoc> {
  if (!['view', 'reveal', 'draft', 'export', 'notify'].includes(action)) {
    throw new AppError('VALIDATION', `Unknown action "${String(action)}"`);
  }
  const res = await byIds(ctx, surface, [companyId]);
  const entry = res.get(String(companyId).toLowerCase() as Id<'company'>);
  const decision = entry?.decision ?? notFoundDecision();
  const deniedAudit = async () => {
    // byIds audits its surface action; make sure a denied *requested* action is also recorded.
    if (surfaceAction(surface) !== action && isUuid(String(companyId))) {
      await recordDecisions(ctx, ['reveal', 'draft', 'export'].includes(action) ? (action as Surface) : surface, [
        { companyId: String(companyId), decision, denied: true },
      ]);
    }
  };
  if (!entry || !entry.doc || decision.visibility === 'hidden') {
    if (decision.reasons.length === 0 || decision.reasons.includes('SUPPRESSED')) {
      throw new AppError('NOT_FOUND', 'Company not found');
    }
    await deniedAudit();
    throw new AppError('POLICY_DENIED', 'This company is not available', { reasons: decision.reasons });
  }
  if (!decision.allowed.includes(action)) {
    await deniedAudit();
    if (decision.reasons.includes('SANCTIONS_BLOCK')) {
      throw new AppError('SANCTIONS_BLOCKED', 'This company is subject to a sanctions block', { reasons: decision.reasons });
    }
    throw new AppError('POLICY_DENIED', `Action "${action}" is not allowed for this company`, { reasons: decision.reasons });
  }
  return entry.doc;
}

// ---------------------------------------------------------------------------------------------
// matchByIdentifiers (for M32)
// ---------------------------------------------------------------------------------------------

/** Consumer mailbox domains: an email there says nothing about which company it belongs to. */
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'aol.com', 'rediffmail.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.de', 'mail.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com', 'zoho.com',
]);

/**
 * Matches a domain and/or email to a catalogue company through the read models' identifier
 * hashes (the only catalogue access M32 gets). Suppressed companies never match.
 */
export async function matchByIdentifiers(
  ctx: ActorContext,
  ids: { domain?: string; email?: string },
): Promise<Id<'company'> | null> {
  const hashes: string[] = [];
  try {
    if (ids.domain && ids.domain.trim()) hashes.push(hashNormalised('domain', normaliseDomain(ids.domain)));
    if (ids.email && ids.email.trim()) {
      const email = normaliseEmail(ids.email);
      hashes.push(hashNormalised('email', email));
      const at = email.lastIndexOf('@');
      if (at > 0) {
        const domain = normaliseDomain(email.slice(at + 1));
        if (!FREEMAIL_DOMAINS.has(domain)) hashes.push(hashNormalised('domain', domain));
      }
    }
  } catch (err) {
    if (err instanceof AppError && err.code === 'VALIDATION') return null;
    throw err;
  }
  if (hashes.length === 0) return null;
  const id = await companyByIdentifierHashes(exec(ctx), [...new Set(hashes)]);
  if (!id) return null;
  // The match must itself be visible to this actor (hides, logistics default, etc.).
  const res = await byIds(ctx, 'profile', [id]);
  const entry = res.get(id as Id<'company'>);
  return entry && entry.decision.visibility !== 'hidden' ? (id as Id<'company'>) : null;
}
