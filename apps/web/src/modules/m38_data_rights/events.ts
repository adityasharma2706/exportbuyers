/**
 * M38 — EV-11 subscriber. M06's own consent.ts doc comment: "Withdrawing core_service behaves
 * like account deletion: the route demands an explicit confirmation, and the EV-11 event starts
 * M38's erase flow." Only `purpose === 'core_service'` starts an erase; every other purpose
 * (marketing_email, whatsapp, analytics) is handled entirely inside M06 and ignored here.
 *
 * Writes the new `rights_request` row and enqueues the `m38.erase` job inside the event's own
 * transaction (`meta.tx`), so both commit atomically with the event being marked handled — if the
 * job runner picks the job up before commit it simply finds nothing (Postgres visibility), and if
 * this handler is retried after a crash the whole transaction (including the outbox's own
 * `platform.event_handled` row) rolls back together, so no duplicate request is created.
 */
import type { ConsentWithdrawnPayload } from '../m06_consent/index.js';
import { CONSENT_WITHDRAWN_EVENT } from '../m06_consent/index.js';
import { log } from '../m01_platform/index.js';
import { enqueue, subscribe, type EventMeta } from '../m02_queue/index.js';
import { ERASE_JOB_TYPE, ERASE_MAX_ATTEMPTS, RIGHTS_JOB_QUEUE, RIGHTS_RATE_CLASS } from './config.js';
import { insertRequestTx } from './repo.js';
import { systemCtxFor } from './systemCtx.js';
import type { EraseJobPayload } from './eraseJob.js';

const HANDLER_NAME = 'm38.consent_withdrawn';

export async function onConsentWithdrawn(payload: ConsentWithdrawnPayload, meta: EventMeta): Promise<void> {
  if (payload.purpose !== 'core_service') return;
  const request = await insertRequestTx(meta.tx, payload.accountId, 'erase', new Date());
  const jobPayload: EraseJobPayload = { v: 1, requestId: request.id, accountId: payload.accountId };
  await enqueue(
    meta.tx,
    {
      type: ERASE_JOB_TYPE,
      queue: RIGHTS_JOB_QUEUE,
      payload: jobPayload,
      idempotencyKey: `m38.erase:${request.id}`,
      maxAttempts: ERASE_MAX_ATTEMPTS,
      rateClass: RIGHTS_RATE_CLASS,
    },
    systemCtxFor(payload.accountId, meta.correlationId),
  );
  log.info({ accountId: payload.accountId, requestId: request.id }, 'm38: consent.withdrawn(core_service) started account erasure');
}

let registered = false;

/** Registers M38's EV-11 subscription. Call once at boot, after M02 and M06 have loaded. */
export function registerDataRightsEvents(): void {
  if (registered) return;
  subscribe(CONSENT_WITHDRAWN_EVENT, HANDLER_NAME, onConsentWithdrawn);
  registered = true;
}

/** For tests. */
export function resetDataRightsEventsForTesting(): void {
  registered = false;
}
