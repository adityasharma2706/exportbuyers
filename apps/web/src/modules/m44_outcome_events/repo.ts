/**
 * M44 — writes to `analytics.outcome_event` (LLD M44 schema). Runs inside the EV-08 handler's
 * own transaction (`meta.tx`, M02's per-event tx that also records `platform.event_handled`),
 * so a retried/duplicate delivery of the same event never double-writes: either the whole
 * transaction (event-handled marker + every row here) commits once, or it rolls back entirely
 * and the job retries from a clean slate.
 */
import { sql } from 'kysely';
import type { Tx } from '../m02_queue/index.js';
import type { OutcomeEventRow } from './types.js';

export async function insertOutcomeEvents(tx: Tx, rows: readonly OutcomeEventRow[]): Promise<void> {
  for (const row of rows) {
    await sql`
      insert into analytics.outcome_event (id, account_id, company_id, hs_heading, country, from_status, to_status, at)
      values (${row.id}::uuid, ${row.accountId}::uuid, ${row.companyId}::uuid, ${row.hsHeading}, ${row.country},
              ${row.fromStatus}, ${row.toStatus}, ${row.at})
    `.execute(tx);
  }
}
