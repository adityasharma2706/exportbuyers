/**
 * M02 — shared types for the job queue, outbox and scheduler.
 */
import type { Db, Id } from '../m01_platform/index.js';

export type QueueName = 'serving' | 'knowledge';
export const QUEUE_NAMES: readonly QueueName[] = ['serving', 'knowledge'];

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'dead';

/**
 * A database handle usable as the caller's transaction: either a Kysely transaction or the
 * plain system Kysely instance. enqueue()/emit() write through it so the job/event commits
 * (or rolls back) together with the caller's own writes.
 */
export type Tx = Db;

/**
 * Structural subset of a zod schema. Any `ZodType<P>` satisfies it, and so does any other
 * validator exposing `safeParse`.
 */
export interface PayloadSchema<P> {
  safeParse(input: unknown): { success: true; data: P } | { success: false; error: { message: string } };
}

export interface EnqueueJob<P> {
  type: string;
  queue: QueueName;
  payload: P;
  idempotencyKey: string;
  runAt?: Date;
  rateClass?: string;
  maxAttempts?: number;
  /** Payload schema version (LLD §0.5). Defaults to payload.v when present, else 1. */
  v?: number;
}

export interface JobMeta {
  jobId: Id<'job'>;
  type: string;
  queue: QueueName;
  /** 1-based number of this attempt. */
  attempt: number;
  maxAttempts: number;
  correlationId: string;
  actorRef: string | null;
  idempotencyKey: string;
  v: number;
  enqueuedAt: Date;
}

export type JobHandlerFn<P> = (payload: P, meta: JobMeta) => Promise<void>;

export interface DeadLetterInfo {
  jobId: Id<'job'>;
  type: string;
  queue: QueueName;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  lastError: string;
  correlationId: string;
  actorRef: string | null;
  /** Why the job was dead-lettered. */
  reason: 'max_attempts' | 'non_retryable' | 'invalid_payload' | 'lease_expired';
}

export type DeadLetterHook = (info: DeadLetterInfo) => Promise<void> | void;

export interface StaleJobAlert {
  type: string;
  queue: QueueName;
  count: number;
  oldestRunAt: Date;
}

export type StaleJobHook = (alert: StaleJobAlert) => Promise<void> | void;

/**
 * Event registry. Modules add their events by declaration merging:
 *
 * ```ts
 * declare module '../m02_queue/index.js' {
 *   interface EventRegistry { 'search.completed': { v: 1; searchId: string } }
 * }
 * ```
 * Unregistered event names are accepted with an `unknown`-typed payload.
 */
export interface EventRegistry {
  [eventType: string]: unknown;
}

export type EventType = keyof EventRegistry & string;
export type EventPayload<E extends EventType> = EventRegistry[E];

export interface EventMeta {
  eventId: Id<'event'>;
  eventType: string;
  correlationId: string;
  /** The transaction that also records (event_id, handler) in platform.event_handled. */
  tx: Tx;
  job: JobMeta;
}

export type EventHandlerFn<P> = (payload: P, meta: EventMeta) => Promise<void>;

/** Throw from a handler to send the job straight to `dead` without retrying. */
export class NonRetryable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'NonRetryable';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isNonRetryable(e: unknown): e is NonRetryable {
  return e instanceof NonRetryable || (e instanceof Error && e.name === 'NonRetryable');
}

/** The row shape of platform.job as returned by the driver. */
export interface JobRow {
  id: string;
  queue: QueueName;
  type: string;
  payload: unknown;
  v: number;
  idempotency_key: string;
  correlation_id: string;
  actor_ref: string | null;
  rate_class: string | null;
  state: JobState;
  attempts: number;
  max_attempts: number;
  run_at: Date | string;
  locked_until: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
