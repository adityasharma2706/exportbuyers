/**
 * M11 — built-in `system.dead_letter` type, the M02 dead-letter hook, and the hourly SLA
 * breach alert.
 */
import { z } from 'zod';
import { log, systemDb } from '../m01_platform/index.js';
import {
  enqueue,
  onDeadLetter,
  registerHandler,
  registerSchedule,
  type DeadLetterInfo,
  type Tx,
} from '../m02_queue/index.js';
import { DEFAULT_SLA_HOURS } from './registry.js';
import { slaBreaches } from './repo.js';
import { file, registerType } from './service.js';
import type { ReviewAlertSink, SlaBreachSummary } from './types.js';

export const DEAD_LETTER_TYPE = 'system.dead_letter';
export const SLA_BREACH_JOB = 'm11.sla_breach_check';
export const SLA_BREACH_SCHEDULE = 'm11.sla_breach_hourly';

const MAX_LAST_ERROR = 4000;

export const deadLetterPayloadSchema = z.object({
  jobId: z.string().uuid(),
  jobType: z.string().min(1).max(200),
  queue: z.enum(['serving', 'knowledge']),
  jobPayload: z.unknown(),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  lastError: z.string().max(MAX_LAST_ERROR),
  reason: z.enum(['max_attempts', 'non_retryable', 'invalid_payload', 'lease_expired']),
  correlationId: z.string().max(200),
  actorRef: z.string().max(400).nullable(),
});
export type DeadLetterPayload = z.infer<typeof deadLetterPayloadSchema>;

export const deadLetterOutcomeSchema = z.object({
  note: z.string().max(2000).optional(),
});
export type DeadLetterOutcome = z.infer<typeof deadLetterOutcomeSchema>;

/** Idempotency key of the requeued copy of a dead job; one requeue per review item. */
export function requeueIdempotencyKey(itemId: string): string {
  return `m11.requeue:${itemId}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function deadLetterPayloadOf(info: DeadLetterInfo): DeadLetterPayload {
  return {
    jobId: info.jobId,
    jobType: info.type,
    queue: info.queue,
    jobPayload: info.payload ?? null,
    attempts: info.attempts,
    maxAttempts: info.maxAttempts,
    lastError: truncate(info.lastError ?? '', MAX_LAST_ERROR),
    reason: info.reason,
    correlationId: truncate(info.correlationId ?? '', 200),
    actorRef: info.actorRef === null ? null : truncate(info.actorRef, 400),
  };
}

function registerDeadLetterType(): void {
  registerType<DeadLetterPayload, DeadLetterOutcome>({
    type: DEAD_LETTER_TYPE,
    payloadSchema: deadLetterPayloadSchema,
    outcomes: ['requeue', 'discard'],
    rejectingOutcomes: ['discard'],
    outcomeSchema: deadLetterOutcomeSchema,
    slaHours: DEFAULT_SLA_HOURS.deadLetter,
    requiredRole: 'admin_ops',
    view: {
      titleKey: 'admin.review.deadLetter.title',
      fields: [
        { path: 'jobType', labelKey: 'admin.review.deadLetter.jobType' },
        { path: 'queue', labelKey: 'admin.review.deadLetter.queue' },
        { path: 'reason', labelKey: 'admin.review.deadLetter.reason' },
        { path: 'attempts', labelKey: 'admin.review.deadLetter.attempts' },
        { path: 'lastError', labelKey: 'admin.review.deadLetter.lastError' },
        { path: 'jobPayload', labelKey: 'admin.review.deadLetter.payload', format: 'json' },
      ],
      outcomeLabelKeys: { requeue: 'admin.review.deadLetter.requeue', discard: 'admin.review.deadLetter.discard' },
      confirmOutcomes: ['discard'],
    },
    onOutcome: async (item, outcome, data, tx: Tx) => {
      if (outcome === 'discard') {
        log.info({ itemId: item.id, jobId: item.payload.jobId, jobType: item.payload.jobType, note: data.note }, 'm11 dead letter discarded');
        return;
      }
      const jobId = await enqueue(tx, {
        type: item.payload.jobType,
        queue: item.payload.queue,
        payload: item.payload.jobPayload ?? {},
        idempotencyKey: requeueIdempotencyKey(item.id),
      });
      log.info({ itemId: item.id, deadJobId: item.payload.jobId, newJobId: jobId, jobType: item.payload.jobType }, 'm11 dead letter requeued');
    },
  });
}

async function fileDeadLetter(info: DeadLetterInfo): Promise<void> {
  const payload = deadLetterPayloadOf(info);
  await systemDb('m11 file dead letter review item')
    .transaction()
    .execute(async (tx: Tx) => {
      await file(tx, DEAD_LETTER_TYPE, {
        subjectRefs: [{ kind: 'job', id: info.jobId }],
        payload,
        filedBy: { kind: 'system', ref: 'm02.queue' },
        dedupeKey: info.jobId,
      });
    });
}

// ---- SLA breach alert --------------------------------------------------------------------

const defaultAlertSink: ReviewAlertSink = (breaches) => {
  for (const b of breaches) {
    log.error({ type: b.type, count: b.count, oldestDueAt: b.oldestDueAt.toISOString() }, 'review queue SLA breached');
  }
};

let alertSink: ReviewAlertSink = defaultAlertSink;

/** Where hourly SLA-breach alerts go (e.g. M41 ops notifications). Defaults to an error log. */
export function setReviewAlertSink(sink: ReviewAlertSink | null): void {
  alertSink = sink ?? defaultAlertSink;
}

/** Runs one breach check; returns the per-type summaries that were alerted. */
export async function runSlaBreachCheck(now: Date = new Date()): Promise<SlaBreachSummary[]> {
  const breaches = await slaBreaches(systemDb('m11 hourly SLA breach check'), now);
  if (breaches.length > 0) await alertSink(breaches);
  return breaches;
}

const emptyPayloadSchema = z.object({}).passthrough();

// ---- module wiring -----------------------------------------------------------------------

let registered = false;
let unhookDeadLetter: (() => void) | undefined;

/**
 * Boot wiring for M11 (call from the web and worker processes before syncRegistrations()):
 * registers `system.dead_letter`, the M02 dead-letter hook and the hourly SLA-breach schedule.
 */
export function registerReviewModule(): void {
  if (registered) return;
  registerDeadLetterType();
  unhookDeadLetter = onDeadLetter(async (info) => {
    try {
      await fileDeadLetter(info);
    } catch (err) {
      log.error({ err, jobId: info.jobId, jobType: info.type }, 'm11 could not file dead-letter review item');
      throw err;
    }
  });
  registerHandler(SLA_BREACH_JOB, emptyPayloadSchema, async () => {
    await runSlaBreachCheck();
  });
  registerSchedule(SLA_BREACH_SCHEDULE, '0 * * * *', SLA_BREACH_JOB, {}, 'serving');
  registered = true;
}

/** Test helper: forgets the wiring flag and detaches the dead-letter hook. */
export function resetReviewModuleForTesting(): void {
  unhookDeadLetter?.();
  unhookDeadLetter = undefined;
  registered = false;
  alertSink = defaultAlertSink;
}
