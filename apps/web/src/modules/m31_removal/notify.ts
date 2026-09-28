/**
 * M31 — outbound email to the requester (LLD M31 Outcomes: "an email to the requester
 * (removal.confirmed)" / "an email to the requester" on reject).
 *
 * The actual send happens through `m31.notify_requester`, a job enqueued *inside* the same
 * transaction as the outcome's other writes (suppression / IF-09b command), so the requester is
 * notified only if that transaction actually commits — the same reasoning M17 uses for its
 * `m17.record_decision` job (see m17_sanctions/review.ts). Delivery itself goes through M05's
 * `sendTransactionalEmail`, which already retries vendor failures via its own job.
 */
import { z } from 'zod';
import { enqueue, registerHandler, type Tx } from '../m02_queue/index.js';
import { sendTransactionalEmail } from '../m05_identity/index.js';

export const NOTIFY_JOB = 'm31.notify_requester';

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
