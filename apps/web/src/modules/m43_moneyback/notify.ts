/**
 * M43 — outbound email to the requester (LLD M43 Outcomes: "approve ... 4. Email to the user" /
 * "reject {reasonKey} -> email to the user").
 *
 * The send is enqueued *inside* the same transaction as the outcome's other writes, so the
 * requester is notified only if that transaction actually commits — the same pattern M31's own
 * `notify.ts` uses for `removal.request`, and M17 uses for `m17.record_decision`. Delivery itself
 * goes through M05's `sendTransactionalEmail`, which already retries vendor failures via its own
 * job.
 *
 * [deviation: implementer.md's Deps list for M43 gives only M11/M28/M36/M37, not M05 — the same
 * gap M31's own `notify.ts` and M41's `service.ts` already document for the identical reason:
 * the LLD's own wording ("an email to the requester" / "an email to the user") requires a
 * transactional-email primitive, M05 is the only module that owns one, and M05 already exists.]
 */
import { z } from 'zod';
import { enqueue, registerHandler, type Tx } from '../m02_queue/index.js';
import { sendTransactionalEmail } from '../m05_identity/index.js';

export const NOTIFY_JOB = 'm43.notify_requester';

const notifyPayloadSchema = z.object({
  to: z.string().email(),
  templateKey: z.string().min(1).max(100),
  params: z.record(z.unknown()),
  idempotencyKey: z.string().min(1).max(200),
});
export type NotifyPayload = z.infer<typeof notifyPayloadSchema>;

export interface EnqueueNotifyInput {
  to: string;
  templateKey: string;
  params: Record<string, unknown>;
  /** Unique per (review item, outcome) so a retried EV-07 handler never sends twice. */
  idempotencyKey: string;
}

export async function enqueueNotify(tx: Tx, p: EnqueueNotifyInput): Promise<void> {
  const key = `${NOTIFY_JOB}:${p.idempotencyKey}`;
  await enqueue(tx, {
    type: NOTIFY_JOB,
    queue: 'serving',
    payload: { to: p.to, templateKey: p.templateKey, params: p.params, idempotencyKey: key },
    idempotencyKey: key,
  });
}

let registered = false;

export function registerNotifyJob(): void {
  if (registered) return;
  registerHandler(NOTIFY_JOB, notifyPayloadSchema, async (p) => {
    await sendTransactionalEmail(p.to, p.templateKey, p.params, { idempotencyKey: p.idempotencyKey });
  });
  registered = true;
}

/** Test hook. */
export function resetNotifyJobForTesting(): void {
  registered = false;
}
