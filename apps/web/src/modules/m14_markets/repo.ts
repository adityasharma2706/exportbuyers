/**
 * M14 — Postgres access to analytics.market_row / analytics.fta (reference data: no tenant scope,
 * read via systemDb). Only the Python knowledge plane writes these tables.
 */
import { sql } from 'kysely';
import { systemDb } from '../m01_platform/index.js';
import { enqueue } from '../m02_queue/index.js';
import type { MarketRepo, MarketRowRecord } from './types.js';
import { WHY_JOB_TYPE, WHY_RATE_CLASS } from './types.js';

export function whyIdempotencyKey(country: string, hs6: string, inputHash: string): string {
  return `${country}:${hs6}:${inputHash}`;
}

export const pgMarketRepo: MarketRepo = {
  async rowsForCode(code, limit) {
    const res = await sql<MarketRowRecord>`
      select m.country, m.hs6, m.data_year, m.import_value_usd, m.cagr_5y, m.india_share, m.top_suppliers,
             m.fta_ref, m.score, m.rank, m.why_text, m.why_input_hash, m.hs_version, m.built_at,
             f.partner as fta_partner, f.agreement as fta_agreement,
             to_char(f.in_force_from, 'YYYY-MM-DD') as fta_in_force_from,
             f.hs_scope as fta_hs_scope, f.notes as fta_notes, f.source_url as fta_source_url
        from analytics.market_row m
        left join analytics.fta f on f.partner = m.country and f.agreement = m.fta_ref
       where m.hs6 = ${code}
       order by m.rank
       limit ${limit}`.execute(systemDb('m14 market rows read'));
    return res.rows;
  },

  async enqueueWhy({ country, hs6, inputHash }) {
    // Same job and idempotency key as the knowledge plane's build (py/kp/m14_markets/jobs.py), so a
    // summary is requested at most once per (country, code, numbers).
    await enqueue(systemDb('m14 lazy why enqueue'), {
      type: WHY_JOB_TYPE,
      queue: 'knowledge',
      payload: { country, hs6, input_hash: inputHash },
      idempotencyKey: whyIdempotencyKey(country, hs6, inputHash),
      rateClass: WHY_RATE_CLASS,
    });
  },
};
