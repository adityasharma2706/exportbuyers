/**
 * M30 — event wiring and scheduled jobs.
 *
 *   contact.invalidated / contact.verified (EV-06, from py/kp/m25_freshness)  -> settle every
 *     `reverifying` report waiting on that assertion (LLD M30 Rules).
 *   m30.reverify_timeout_sweep (hourly)  -> LLD M30: "if M25 reports unknown after 24 h", settled
 *     the same way as a ContactVerified outcome (capped, unconfirmed refund).
 *   IF-10b `userHides` provider registration (REQ-025): M30 owns serving.user_hide, so it is the
 *     module that fills M10's provider slot.
 *
 * Call registerReportsModule() once at boot (web and worker), before M02's syncRegistrations().
 */
import { z } from 'zod';
import { log, systemDb } from '../m01_platform/index.js';
import { registerEventSchema, registerHandler, registerSchedule, subscribe, type EventMeta, type Tx } from '../m02_queue/index.js';
import { registerProvider } from '../m10_policy/index.js';
import { reportsConfig } from './config.js';
import {
  EV_CONTACT_INVALIDATED,
  EV_CONTACT_VERIFIED,
  EV_REPORT_FILED,
  contactInvalidatedSchema,
  contactVerifiedSchema,
  reportFiledSchema,
} from './events.js';
import { hiddenAssertions, hiddenCompanies, findReverifyingReportsByAssertion, findTimedOutReverifyingReports } from './repo.js';
import { settleInvalidContactReport } from './refunds.js';
import { registerReportReviewTypes } from './reviewTypes.js';
import type { ContactInvalidatedPayload, ContactVerifiedPayload } from './types.js';

export const SWEEP_JOB = 'm30.reverify_timeout_sweep';
export const SWEEP_SCHEDULE = 'm30-reverify-timeout-sweep';
/** [tunable] batch size per sweep pass; large enough for the nightly M25 staleness fan-out
 * (LLD M25: up to 5000/night) to never starve reports filed the same day. */
const SWEEP_BATCH_SIZE = 500;

const sweepPayloadSchema = z.object({ v: z.literal(1) });

async function onContactInvalidated(payload: ContactInvalidatedPayload, meta: EventMeta): Promise<void> {
  const reports = await findReverifyingReportsByAssertion(meta.tx, payload.assertionId);
  for (const r of reports) {
    if (r.company_id.toLowerCase() !== payload.companyId.toLowerCase()) continue;
    await settleInvalidContactReport(meta.tx, r, 'confirmed');
  }
}

async function onContactVerified(payload: ContactVerifiedPayload, meta: EventMeta): Promise<void> {
  const reports = await findReverifyingReportsByAssertion(meta.tx, payload.assertionId);
  for (const r of reports) {
    if (r.company_id.toLowerCase() !== payload.companyId.toLowerCase()) continue;
    await settleInvalidContactReport(meta.tx, r, 'unconfirmed');
  }
}

/** Runs one sweep pass; exported for tests and manual operation. */
export async function runReverifyTimeoutSweep(now: Date = new Date()): Promise<{ processed: number }> {
  const cutoff = new Date(now.getTime() - reportsConfig().reverifyTimeoutHours * 3_600_000);
  const db = systemDb('m30: reverify timeout sweep');
  const candidates = await findTimedOutReverifyingReports(db, cutoff, SWEEP_BATCH_SIZE);
  let processed = 0;
  for (const r of candidates) {
    try {
      await db.transaction().execute(async (tx: Tx) => settleInvalidContactReport(tx, r, 'unconfirmed', now));
      processed++;
    } catch (err) {
      log.error({ err, reportId: r.id }, 'm30: failed to settle a timed-out reverifying report');
    }
  }
  return { processed };
}

let registered = false;

export function registerReportsModule(): void {
  if (registered) return;

  registerProvider('userHides', {
    hiddenCompanies: (accountId) => hiddenCompanies(String(accountId)),
    hiddenAssertions: (accountId) => hiddenAssertions(String(accountId)),
  });

  registerReportReviewTypes();

  registerEventSchema(EV_REPORT_FILED, reportFiledSchema);
  registerEventSchema(EV_CONTACT_INVALIDATED, contactInvalidatedSchema);
  registerEventSchema(EV_CONTACT_VERIFIED, contactVerifiedSchema);
  subscribe(EV_CONTACT_INVALIDATED, 'm30.contact_invalidated', onContactInvalidated as (p: unknown, m: EventMeta) => Promise<void>);
  subscribe(EV_CONTACT_VERIFIED, 'm30.contact_verified', onContactVerified as (p: unknown, m: EventMeta) => Promise<void>);

  registerHandler(SWEEP_JOB, sweepPayloadSchema, async () => {
    const r = await runReverifyTimeoutSweep();
    if (r.processed > 0) log.info(r, 'm30: reverify timeout sweep');
  });
  registerSchedule(SWEEP_SCHEDULE, '17 * * * *', SWEEP_JOB, { v: 1 }, 'serving');

  registered = true;
}

/** Test hook. */
export function resetReportsModuleForTesting(): void {
  registered = false;
}
