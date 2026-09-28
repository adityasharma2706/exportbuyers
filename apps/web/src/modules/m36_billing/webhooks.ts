/**
 * M36 — POST /webhooks/razorpay (LLD M36 "Webhook rules"):
 *   1. Verify HMAC_SHA256(webhook_secret, raw_body) with a constant-time compare. On failure -> 400.
 *   2. INSERT webhook_event ... ON CONFLICT DO NOTHING. A duplicate -> 200, no processing.
 *   3/4. Return 200 within 5 s; the actual event handling (jobs.ts) runs as a job.
 *
 * [deviation: Razorpay's webhook delivery does not reliably carry a distinct event-id header
 * across all account/dashboard configurations. `serving.webhook_event.razorpay_event_id` (the
 * primary key our idempotent insert relies on) is therefore the `X-Razorpay-Event-Id` header when
 * present, falling back to sha256(raw_body) otherwise — an exact redelivery of the same payload
 * (Razorpay's own retry behaviour) hashes to the same id either way, which is what the "duplicate
 * -> 200, no processing" rule needs.]
 */
import { createHash } from 'node:crypto';
import { systemDb } from '../m01_platform/index.js';
import { enqueue } from '../m02_queue/index.js';
import { systemExec } from './exec.js';
import { insertWebhookEventIfNew } from './repo.js';
import { verifyRazorpayWebhookSignature } from './razorpay.js';
import { PROCESS_WEBHOOK_JOB } from './jobs.js';

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function eventIdOf(headerValue: string | undefined, rawBody: string): string {
  const h = headerValue?.trim();
  if (h && h.length > 0) return h;
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

/**
 * Handles one Razorpay webhook delivery. `rawBody` must be the exact bytes Razorpay sent (before
 * any JSON re-serialisation), since the signature is computed over it.
 */
export async function handleRazorpayWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  eventIdHeader: string | undefined,
): Promise<WebhookResult> {
  if (!verifyRazorpayWebhookSignature(rawBody, signatureHeader)) {
    return { status: 400, body: { error: { code: 'VALIDATION', message: 'Invalid webhook signature' } } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: { code: 'VALIDATION', message: 'Malformed JSON body' } } };
  }
  const type = isRecord(payload) && typeof payload.event === 'string' ? payload.event : 'unknown';
  const eventId = eventIdOf(eventIdHeader, rawBody);

  // There is no request actor for an unauthenticated server-to-server callback, so this always
  // goes through systemExec(); the idempotent INSERT is the concurrency guard (LLD rule 2: "ON
  // CONFLICT DO NOTHING. A duplicate -> 200 and no processing").
  const exec = systemExec('webhook event insert');
  const created = await insertWebhookEventIfNew(exec, { id: eventId, type, payloadJson: payload });

  if (created) {
    await enqueue(systemDb('m36: enqueue webhook processing'), {
      type: PROCESS_WEBHOOK_JOB,
      queue: 'serving',
      payload: { v: 1, eventId },
      idempotencyKey: eventId,
    });
  }

  return { status: 200, body: { received: true } };
}
