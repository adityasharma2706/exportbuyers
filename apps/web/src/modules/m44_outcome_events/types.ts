/**
 * M44 Outcome events — shared types (LLD M44).
 *
 * "EV-08 handler -> analytics.outcome_event(id, account_id, company_id, hs_heading, country,
 * from_status, to_status, at), written only for to_status in {replied, in_discussion,
 * order_won}. Nothing else is written, and there is no personal data."
 */
import type { ShortlistStatus } from '../m33_pipeline/index.js';

/** LLD M44: the only three `to_status` values this module ever writes a row for. */
export const OUTCOME_TO_STATUSES = ['replied', 'in_discussion', 'order_won'] as const;
export type OutcomeToStatus = (typeof OUTCOME_TO_STATUSES)[number];

const OUTCOME_TO_STATUS_SET: ReadonlySet<string> = new Set(OUTCOME_TO_STATUSES);

export function isOutcomeToStatus(status: ShortlistStatus): status is OutcomeToStatus {
  return OUTCOME_TO_STATUS_SET.has(status);
}

/** A row of `analytics.outcome_event`, one per (company, hs_heading) pair written. */
export interface OutcomeEventRow {
  id: string;
  accountId: string;
  companyId: string;
  hsHeading: string | null;
  country: string;
  fromStatus: ShortlistStatus | null;
  toStatus: OutcomeToStatus;
  at: Date;
}
