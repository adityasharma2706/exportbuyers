/**
 * M44 Outcome events (LLD M44). REQ-050.
 *
 * "Status changes to Replied, In discussion or Order won emit outcome events to the analytics
 * schema for success metrics and relevance tuning." / "EV-08 handler -> analytics.outcome_event
 * (id, account_id, company_id, hs_heading, country, from_status, to_status, at), written only
 * for to_status in {replied, in_discussion, order_won}. Nothing else is written, and there is no
 * personal data."
 *
 * Call registerOutcomeEventsModule() once at boot (web and worker), after M33 has loaded.
 */
import { log, newId, withSpan, type Id } from '../m01_platform/index.js';
import { subscribe, type EventMeta } from '../m02_queue/index.js';
import { byIds, type ProfileDoc } from '../m10_policy/index.js';
import { EV_PIPELINE_STATUS_CHANGED, type PipelineStatusChangedPayload } from '../m33_pipeline/index.js';
import { insertOutcomeEvents } from './repo.js';
import { systemCtxFor } from './systemCtx.js';
import { isOutcomeToStatus, type OutcomeEventRow } from './types.js';

/**
 * Pure mapping from an EV-08 payload plus the company's (already policy-evaluated) profile doc
 * to the rows this module writes.
 *
 * [deviation, see the migration's own note: `profile_doc.doc.hs_headings` can hold more than one
 * heading (or none). One row is written per heading the company currently carries evidence for,
 * rather than picking an arbitrary single one, since search_doc — the LLD's own source of HS
 * scope — is itself keyed `(company_id, hs_heading)`. `hs_heading` is `null` in the (rare) case
 * a company has none yet, so the outcome is still recorded rather than silently dropped.]
 */
export function buildOutcomeEventRows(
  payload: PipelineStatusChangedPayload,
  doc: Pick<ProfileDoc, 'country' | 'hs_headings'>,
  now: Date = new Date(payload.at),
): OutcomeEventRow[] {
  if (!isOutcomeToStatus(payload.toStatus)) return [];
  const headings = Array.isArray(doc.hs_headings) && doc.hs_headings.length > 0 ? [...new Set(doc.hs_headings)] : [null];
  return headings.map((hsHeading) => ({
    id: newId<'outcome_event'>(),
    accountId: payload.accountId,
    companyId: payload.companyId,
    hsHeading,
    country: doc.country,
    fromStatus: payload.fromStatus,
    toStatus: payload.toStatus,
    at: now,
  }));
}

async function onPipelineStatusChanged(payload: PipelineStatusChangedPayload, meta: EventMeta): Promise<void> {
  if (!isOutcomeToStatus(payload.toStatus)) return; // LLD: written only for these three to_status values

  await withSpan(
    'm44.outcome_event',
    async () => {
      const sysCtx = systemCtxFor(payload.accountId);
      // Re-evaluated through M10 so a globally suppressed / hidden company never gets an
      // analytics row written after the fact (same reasoning as M41's own `notify()` guard).
      const decisions = await byIds(sysCtx, 'notify', [payload.companyId as Id<'company'>]);
      const entry = decisions.get(payload.companyId as Id<'company'>);
      if (!entry || !entry.doc) {
        log.info(
          { accountId: payload.accountId, companyId: payload.companyId, toStatus: payload.toStatus },
          'm44: outcome event dropped, company is not visible on the notify surface',
        );
        return;
      }

      const rows = buildOutcomeEventRows(payload, entry.doc, new Date(payload.at));
      if (rows.length === 0) return;
      await insertOutcomeEvents(meta.tx, rows);
    },
    { toStatus: payload.toStatus },
  );
}

let registered = false;

/** Wires the EV-08 subscription. Idempotent; safe to call more than once. */
export function registerOutcomeEventsModule(): void {
  if (registered) return;
  subscribe(EV_PIPELINE_STATUS_CHANGED, 'm44.outcome_event', onPipelineStatusChanged);
  registered = true;
}

/** Test hook. */
export function resetOutcomeEventsModuleForTesting(): void {
  registered = false;
}
