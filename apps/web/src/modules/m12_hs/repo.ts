/**
 * M12 — Postgres access to the HS nomenclature tables (reference data: no tenant scope, read via
 * systemDb). Only the Python knowledge-plane loaders write these tables.
 */
import { sql } from 'kysely';
import { systemDb } from '../m01_platform/index.js';
import type { CorrelationColumn, HsCodeRow, HsCorrelationRow, HsFamily, HsRepo } from './types.js';

const CODE_COLUMNS = [
  'version',
  'code',
  'level',
  'parent_code',
  'description',
  'description_en_simple',
  'export_policy',
  'policy_conditions',
  'policy_source_url',
] as const;

const CORRELATION_COLUMNS = ['from_version', 'from_code', 'to_version', 'to_code', 'relation'] as const;

/** pgvector text literal: '[0.1,0.2,...]'. Callers validate finiteness first. */
export function toVectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => (Object.is(x, -0) ? '0' : String(x))).join(',')}]`;
}

export const pgHsRepo: HsRepo = {
  async children(version, parentCode) {
    let q = systemDb('m12 hs browse')
      .selectFrom('knowledge.hs_code')
      .select([...CODE_COLUMNS])
      .where('version', '=', version);
    q = parentCode === null ? q.where('level', '=', 'chapter') : q.where('parent_code', '=', parentCode);
    return (await q.orderBy('code').execute()) as HsCodeRow[];
  },

  async one(version, code) {
    const row = await systemDb('m12 hs lookup')
      .selectFrom('knowledge.hs_code')
      .select([...CODE_COLUMNS])
      .where('version', '=', version)
      .where('code', '=', code)
      .executeTakeFirst();
    return row as HsCodeRow | undefined;
  },

  async nearest(version, embedding, k, levels) {
    const vec = toVectorLiteral(embedding);
    const levelFilter =
      levels && levels.length > 0 ? sql`and level in (${sql.join(levels.map((l) => sql`${l}`))})` : sql``;
    const res = await sql<HsCodeRow>`
      select version, code, level, parent_code, description, description_en_simple,
             export_policy, policy_conditions, policy_source_url,
             1 - (embedding <=> ${vec}::vector) as similarity
        from knowledge.hs_code
       where version = ${version}
         and embedding is not null
         ${levelFilter}
       order by embedding <=> ${vec}::vector
       limit ${k}`.execute(systemDb('m12 hs vector search'));
    return res.rows;
  },

  async currentVersion(family: HsFamily) {
    const res = await sql<{ version: string }>`
      select version from knowledge.hs_version
       where is_current and regexp_replace(version, '[0-9]{4}$', '') = ${family}
       limit 1`.execute(systemDb('m12 hs current version'));
    return res.rows[0]?.version;
  },

  async hasCorrelationTable(fromVersion, toVersion) {
    const row = await systemDb('m12 hs correlation table check')
      .selectFrom('knowledge.hs_correlation')
      .select('from_code')
      .where('from_version', '=', fromVersion)
      .where('to_version', '=', toVersion)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  },

  async correlationRows(fromVersion, toVersion, column: CorrelationColumn, code, exact) {
    const q = systemDb('m12 hs correlate')
      .selectFrom('knowledge.hs_correlation')
      .select([...CORRELATION_COLUMNS])
      .where('from_version', '=', fromVersion)
      .where('to_version', '=', toVersion);
    // Codes are validated as digits only by the caller, so the LIKE pattern has no wildcards in it.
    const filtered = exact ? q.where(column, '=', code) : q.where(column, 'like', `${code}%`);
    return (await filtered.orderBy('from_code').orderBy('to_code').execute()) as HsCorrelationRow[];
  },
};
