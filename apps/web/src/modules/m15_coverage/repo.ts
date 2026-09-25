/**
 * M15 — Postgres read of knowledge.coverage_cell (reference data: no tenant scope, read via systemDb).
 * Only the Python knowledge plane writes this table.
 */
import { sql } from 'kysely';
import { systemDb } from '../m01_platform/index.js';
import type { CoverageCellRecord, CoverageRepo } from './types.js';
import { COUNTRY_FALLBACK } from './types.js';

export const pgCoverageRepo: CoverageRepo = {
  async cellsFor(country, hsHeading) {
    const res = await sql<CoverageCellRecord>`
      select country, hs_heading, source_types, company_count, fresh_company_count, label,
             explanation_key, params, rule_version, computed_at
        from knowledge.coverage_cell
       where country = ${country}
         and hs_heading in (${hsHeading}, ${COUNTRY_FALLBACK})`.execute(systemDb('m15 coverage read'));
    return res.rows;
  },
};
