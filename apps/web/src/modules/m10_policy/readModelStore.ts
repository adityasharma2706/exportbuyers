/**
 * M10 — the ONLY file allowed to reference the knowledge read-model views (`v_search_doc`,
 * `v_profile_doc`, `v_company_redirect`) and the base tables M10 is granted DELETE on
 * (`search_doc`, `profile_doc`, for the zero-window suppression purge).
 *
 * SearchQuery (IF-09d) is compiled to parameterised SQL here. Rules 1 (suppression, as a
 * NOT EXISTS subquery), 5 (logistics default hide) and 6 (per-user hides) run set-based.
 */
import { sql, type RawBuilder } from 'kysely';
import type { Db, ScopedDb } from '../m01_platform/index.js';
import type { ProfileDoc, SearchDoc, SearchQuery } from './types.js';

/** Runs a raw query and returns its rows (adapts ScopedDb and plain Kysely / transactions). */
export type Exec = <R>(q: RawBuilder<R>) => Promise<R[]>;

export function execFromScoped(db: ScopedDb): Exec {
  return <R>(q: RawBuilder<R>) => db.raw<R>(q);
}

export function execFromDb(db: Db): Exec {
  return async <R>(q: RawBuilder<R>) => (await q.execute(db)).rows;
}

const SUPPRESSED_ANY = (col: RawBuilder<unknown>) =>
  sql`exists (select 1 from knowledge.suppression sp where sp.hash = any(${col}))`;

export interface SearchPage {
  offset: number;
  limit: number;
}

export interface SearchRowOut {
  company_id: string;
  doc: SearchDoc;
}

function conditions(q: SearchQuery, hiddenCompanyIds: readonly string[]): RawBuilder<unknown>[] {
  const c: RawBuilder<unknown>[] = [];
  // Rule 1 (belt and braces; the EV-04 purge is the primary control).
  c.push(sql`not ${SUPPRESSED_ANY(sql.ref('s.identifier_hashes'))}`);
  c.push(sql`s.hs_heading = any(${[...q.hsHeadings]}::text[])`);
  if (q.countries.length > 0) c.push(sql`s.country = any(${[...q.countries]}::text[])`);
  if (q.keyword && q.keyword.trim() !== '') c.push(sql`s.tsv @@ websearch_to_tsquery('simple', ${q.keyword.trim()})`);
  if (q.buyerTypes && q.buyerTypes.length > 0) c.push(sql`s.buyer_type = any(${[...q.buyerTypes]}::text[])`);
  if (q.activeWithinMonths !== undefined) {
    c.push(sql`s.last_activity >= (current_date - make_interval(months => ${q.activeWithinMonths}::int))::date`);
  }
  if (q.minShipments12m !== undefined) c.push(sql`s.shipment_freq >= ${q.minShipments12m}::int`);
  if (q.trustLevels && q.trustLevels.length > 0) c.push(sql`s.trust_level = any(${[...q.trustLevels]}::text[])`);
  if (q.contactTypes && q.contactTypes.length > 0) c.push(sql`s.contact_types && ${[...q.contactTypes]}::text[]`);
  if (q.originIndia !== undefined) c.push(sql`s.origin_india = ${q.originIndia ? 'yes' : 'no'}`);
  if (q.originCompetitor !== undefined) c.push(sql`s.origin_competitor = ${q.originCompetitor ? 'yes' : 'no'}`);
  // Rule 5.
  if (!q.includeLogistics) c.push(sql`not s.is_logistics`);
  // Rule 6.
  if (hiddenCompanyIds.length > 0) c.push(sql`s.company_id <> all(${[...hiddenCompanyIds]}::uuid[])`);
  return c;
}

function rankExpr(q: SearchQuery): RawBuilder<unknown> {
  return q.keyword && q.keyword.trim() !== ''
    ? sql`ts_rank(s.tsv, websearch_to_tsquery('simple', ${q.keyword.trim()}))`
    : sql`0::real`;
}

function orderBy(q: SearchQuery): RawBuilder<unknown> {
  switch (q.sort) {
    case 'recency':
      return sql`b.last_activity desc nulls last, b.volume_score desc nulls last, b.company_id`;
    case 'volume':
      return sql`b.volume_score desc nulls last, b.shipment_freq desc nulls last, b.company_id`;
    case 'trust':
      return sql`b.trust_ord desc, b.volume_score desc nulls last, b.last_activity desc nulls last, b.company_id`;
    case 'relevance':
    default:
      return sql`b.rank desc, b.volume_score desc nulls last, b.last_activity desc nulls last, b.company_id`;
  }
}

/**
 * One row per company (its best-matching heading), filtered by rules 1, 5 and 6, sorted and
 * paged. `total` counts matching companies.
 */
export async function searchDocs(
  exec: Exec,
  q: SearchQuery,
  hiddenCompanyIds: readonly string[],
  page: SearchPage,
): Promise<{ rows: SearchRowOut[]; total: number }> {
  const where = sql.join(conditions(q, hiddenCompanyIds), sql` and `);
  const matched = sql`
    select s.company_id, s.hs_heading, s.doc, s.last_activity, s.volume_score, s.shipment_freq,
           case s.trust_level when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end as trust_ord,
           ${rankExpr(q)} as rank
      from knowledge.v_search_doc s
     where ${where}`;
  const best = sql`
    select distinct on (m.company_id) m.*
      from matched m
     order by m.company_id, m.rank desc, m.volume_score desc nulls last, m.hs_heading`;

  let rows: Array<{ company_id: string; doc: SearchDoc; total: string | number }> = [];
  if (page.limit > 0) {
    rows = await exec(
      sql<{ company_id: string; doc: SearchDoc; total: string | number }>`
        with matched as (${matched}), best as (${best})
        select b.company_id::text as company_id, b.doc, count(*) over () as total
          from best b
         order by ${orderBy(q)}
         limit ${page.limit}::int offset ${page.offset}::int`,
    );
  }
  let total: number;
  if (rows.length > 0) {
    total = Number(rows[0]!.total);
  } else {
    const c = await exec(
      sql<{ n: string | number }>`
        with matched as (${matched})
        select count(distinct company_id) as n from matched`,
    );
    total = Number(c[0]?.n ?? 0);
  }
  return { rows: rows.map((r) => ({ company_id: r.company_id, doc: r.doc })), total };
}

export interface ProfileRowOut {
  requestedId: string;
  companyId: string | null;
  doc: ProfileDoc | null;
  sanctionsBlock: boolean;
  isLogistics: boolean;
  suppressed: boolean;
}

/**
 * Profile docs for `ids`, following merge redirects (HLD OQ3). A requested id whose doc is
 * missing comes back with `doc: null`. `suppressed` is rule 1 evaluated in SQL.
 */
export async function profileDocs(exec: Exec, ids: readonly string[]): Promise<ProfileRowOut[]> {
  if (ids.length === 0) return [];
  const rows = await exec(
    sql<{
      requested_id: string;
      company_id: string | null;
      doc: ProfileDoc | null;
      sanctions_block: boolean | null;
      is_logistics: boolean | null;
      suppressed: boolean | null;
    }>`
      select req.id::text as requested_id, p.company_id::text as company_id, p.doc, p.sanctions_block, p.is_logistics,
             case when p.company_id is null then false
                  else ${SUPPRESSED_ANY(sql.ref('p.identifier_hashes'))} end as suppressed
        from unnest(${[...ids]}::uuid[]) as req(id)
        left join knowledge.v_company_redirect r on r.id = req.id
        left join knowledge.v_profile_doc p on p.company_id = coalesce(r.current_id, req.id)`,
  );
  return rows.map((r) => ({
    requestedId: r.requested_id,
    companyId: r.company_id,
    doc: r.doc,
    sanctionsBlock: r.sanctions_block === true,
    isLogistics: r.is_logistics === true,
    suppressed: r.suppressed === true,
  }));
}

export interface CompanyFacts {
  facts: ProfileDoc['facts'];
  fieldSources: Record<string, string[]>;
  nonExportable: string[];
}

/** Provenance of every displayed fact of the given companies (from their profile docs). */
export async function factsForCompanies(exec: Exec, companyIds: readonly string[]): Promise<Map<string, CompanyFacts>> {
  const out = new Map<string, CompanyFacts>();
  if (companyIds.length === 0) return out;
  const rows = await exec(
    sql<{ company_id: string; facts: ProfileDoc['facts'] | null; field_sources: Record<string, string[]> | null; non_exportable: string[] | null }>`
      select p.company_id::text as company_id, p.doc -> 'facts' as facts, p.doc -> 'field_sources' as field_sources,
             p.doc -> 'non_exportable_assertion_ids' as non_exportable
        from knowledge.v_profile_doc p
       where p.company_id = any(${[...companyIds]}::uuid[])`,
  );
  for (const r of rows) {
    out.set(r.company_id, {
      facts: Array.isArray(r.facts) ? r.facts : [],
      fieldSources: r.field_sources ?? {},
      nonExportable: Array.isArray(r.non_exportable) ? r.non_exportable : [],
    });
  }
  return out;
}

/** A non-suppressed company carrying any of `hashes` (current id after merges), or null. */
export async function companyByIdentifierHashes(exec: Exec, hashes: readonly string[]): Promise<string | null> {
  if (hashes.length === 0) return null;
  const rows = await exec(
    sql<{ company_id: string }>`
      select coalesce(r.current_id, p.company_id)::text as company_id
        from knowledge.v_profile_doc p
        left join knowledge.v_company_redirect r on r.id = p.company_id
       where p.identifier_hashes && ${[...hashes]}::text[]
         and not ${SUPPRESSED_ANY(sql.ref('p.identifier_hashes'))}
       order by p.built_at desc
       limit 1`,
  );
  return rows[0]?.company_id ?? null;
}

/** Companies whose read-model docs carry any of `hashes`. */
export async function companiesCarrying(exec: Exec, hashes: readonly string[]): Promise<string[]> {
  if (hashes.length === 0) return [];
  const rows = await exec(
    sql<{ company_id: string }>`
      select company_id::text as company_id from knowledge.v_profile_doc where identifier_hashes && ${[...hashes]}::text[]
      union
      select company_id::text as company_id from knowledge.v_search_doc where identifier_hashes && ${[...hashes]}::text[]`,
  );
  return rows.map((r) => r.company_id);
}

/**
 * EV-04 zero-window purge: deletes the search and profile docs of `companyIds`
 * (M10's documented DELETE grant). Returns the number of rows removed.
 */
export async function deleteDocs(exec: Exec, companyIds: readonly string[]): Promise<number> {
  if (companyIds.length === 0) return 0;
  const ids = [...companyIds];
  const a = await exec(
    sql<{ n: string | number }>`
      with d as (delete from knowledge.search_doc where company_id = any(${ids}::uuid[]) returning 1)
      select count(*) as n from d`,
  );
  const b = await exec(
    sql<{ n: string | number }>`
      with d as (delete from knowledge.profile_doc where company_id = any(${ids}::uuid[]) returning 1)
      select count(*) as n from d`,
  );
  return Number(a[0]?.n ?? 0) + Number(b[0]?.n ?? 0);
}

/** Suppression-list membership for `hashes`. */
export async function suppressedAmong(exec: Exec, hashes: readonly string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const rows = await exec(
    sql<{ hash: string }>`select hash from knowledge.suppression where hash = any(${[...hashes]}::text[])`,
  );
  return new Set(rows.map((r) => r.hash));
}

/** Inserts suppression rows; existing hashes are left untouched (first reason wins). */
export async function insertSuppression(
  exec: Exec,
  rows: ReadonlyArray<{ hash: string; kind: string }>,
  reason: string,
  reviewItemId: string | null,
): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await exec(
    sql<{ hash: string }>`
      insert into knowledge.suppression (hash, kind, reason, review_item_id)
      select h, k, ${reason}, ${reviewItemId}::uuid
        from unnest(${rows.map((r) => r.hash)}::text[], ${rows.map((r) => r.kind)}::text[]) as t(h, k)
      on conflict (hash) do nothing
      returning hash`,
  );
  return inserted.length;
}
