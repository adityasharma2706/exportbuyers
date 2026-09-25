/**
 * M02 — producer-side API.
 *
 *   IF-02a enqueue(tx, job, ctx?)      durable, idempotent on (type, idempotencyKey)
 *   IF-02c emit(tx, type, payload)     transactional outbox insert
 *          subscribe(type, handler, fn) registers the `evt:<type>:<handler>` job handler
 */
import {
  AppError,
  currentCorrelationId,
  log,
  newId,
  type ActorContext,
  type Id,
} from '../m01_platform/index.js';
import { insertJob, insertOutbox, markEventHandled } from './repo.js';
import {
  JOB_TYPE_RE,
  NAME_RE,
  addSubscription,
  assertJobType,
  assertQueue,
  eventJobType,
  getEventSchema,
  registerHandler,
} from './registry.js';
import {
  NonRetryable,
  type EnqueueJob,
  type EventHandlerFn,
  type EventPayload,
  type EventType,
  type PayloadSchema,
  type QueueName,
  type Tx,
} from './types.js';

export const DEFAULT_MAX_ATTEMPTS = 8;
const MAX_KEY_LENGTH = 400;

/** `kind:accountId:memberId` — enough to attribute the job without storing PII. */
export function actorRefOf(ctx: ActorContext | undefined): string | null {
  if (!ctx) return null;
  if (ctx.kind === 'anonymous') return `anonymous:${ctx.anonSessionId ?? ''}`;
  return `${ctx.kind}:${ctx.accountId ?? ''}:${ctx.memberId ?? ''}`;
}

function versionOf(payload: unknown, explicit: number | undefined): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 1) throw new AppError('VALIDATION', 'Payload version v must be an integer >= 1');
    return explicit;
  }
  if (payload !== null && typeof payload === 'object' && 'v' in payload) {
    const v = (payload as { v: unknown }).v;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return v;
  }
  return 1;
}

function toJson(payload: unknown, what: string): string {
  let s: string | undefined;
  try {
    s = JSON.stringify(payload ?? {});
  } catch (e) {
    throw new AppError('VALIDATION', `${what}: payload is not JSON-serialisable`, undefined, { cause: e });
  }
  if (s === undefined) throw new AppError('VALIDATION', `${what}: payload is not JSON-serialisable`);
  return s;
}

function correlationFor(ctx: ActorContext | undefined): string {
  return ctx?.correlationId ?? currentCorrelationId() ?? newId<'correlation'>();
}

/**
 * IF-02a. Inserts the job inside the caller's transaction. On a (type, idempotencyKey)
 * conflict it returns the existing job's id and does not modify that job.
 */
export async function enqueue<P>(tx: Tx, job: EnqueueJob<P>, ctx?: ActorContext): Promise<Id<'job'>> {
  assertJobType(job.type);
  assertQueue(job.queue);
  if (typeof job.idempotencyKey !== 'string' || job.idempotencyKey.length === 0 || job.idempotencyKey.length > MAX_KEY_LENGTH) {
    throw new AppError('VALIDATION', `enqueue(${job.type}): idempotencyKey must be 1..${MAX_KEY_LENGTH} chars`);
  }
  const maxAttempts = job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new AppError('VALIDATION', `enqueue(${job.type}): maxAttempts must be an integer in 1..100`);
  }
  if (job.rateClass !== undefined && !NAME_RE.test(job.rateClass)) {
    throw new AppError('VALIDATION', `enqueue(${job.type}): invalid rateClass "${job.rateClass}"`);
  }
  if (job.runAt !== undefined && !(job.runAt instanceof Date && Number.isFinite(job.runAt.getTime()))) {
    throw new AppError('VALIDATION', `enqueue(${job.type}): runAt must be a valid Date`);
  }
  const res = await insertJob(tx, {
    id: newId<'job'>(),
    queue: job.queue,
    type: job.type,
    payloadJson: toJson(job.payload, `enqueue(${job.type})`),
    v: versionOf(job.payload, job.v),
    idempotencyKey: job.idempotencyKey,
    correlationId: correlationFor(ctx),
    actorRef: actorRefOf(ctx),
    rateClass: job.rateClass ?? null,
    maxAttempts,
    runAt: job.runAt ?? null,
  });
  if (!res.created) {
    log.debug({ jobType: job.type, jobId: res.id }, 'enqueue: idempotency key already used; returning existing job');
  }
  return res.id as Id<'job'>;
}

/**
 * IF-02c. Writes the event to platform.outbox inside the caller's transaction; the
 * dispatcher fans it out to subscribers after commit. Returns the event id.
 * If an event schema was registered with registerEventSchema(), the payload is validated.
 */
export async function emit<E extends EventType>(tx: Tx, type: E, payload: EventPayload<E>): Promise<Id<'event'>> {
  if (typeof type !== 'string' || !JOB_TYPE_RE.test(type)) throw new AppError('VALIDATION', `Invalid event type "${String(type)}"`);
  const schema = getEventSchema(type);
  if (schema) {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError('VALIDATION', `emit(${type}): payload failed schema validation`, { issues: parsed.error.message });
    }
  }
  const id = newId<'event'>();
  await insertOutbox(tx, {
    id,
    eventType: type,
    payloadJson: toJson(payload, `emit(${type})`),
    v: versionOf(payload, undefined),
    correlationId: currentCorrelationId() ?? newId<'correlation'>(),
  });
  return id;
}

/** Payload of the `evt:<event_type>:<handler>` jobs created by the dispatcher. */
export interface EventJobPayload {
  eventId: string;
  eventType: string;
  v: number;
  payload: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const eventJobSchema: PayloadSchema<EventJobPayload> = {
  safeParse(input: unknown) {
    if (input === null || typeof input !== 'object') return { success: false, error: { message: 'event job payload must be an object' } };
    const o = input as Record<string, unknown>;
    if (typeof o.eventId !== 'string' || !UUID_RE.test(o.eventId)) return { success: false, error: { message: 'eventId must be a uuid' } };
    if (typeof o.eventType !== 'string' || o.eventType.length === 0) return { success: false, error: { message: 'eventType is required' } };
    const v = typeof o.v === 'number' && Number.isInteger(o.v) ? o.v : 1;
    return { success: true, data: { eventId: o.eventId, eventType: o.eventType, v, payload: o.payload } };
  },
};

export interface SubscribeOptions {
  /** Queue the handler job runs on. Defaults to 'serving' (the TS worker's queue). */
  queue?: QueueName;
}

/**
 * IF-02c. Registers `fn` for events of `type`. The dispatcher enqueues one job per
 * (event, handler) with idempotency key `<outbox.id>:<handler>`. The handler runs inside a
 * transaction that first records (event_id, handler) in platform.event_handled and skips the
 * event if the pair is already recorded, so redelivery is harmless.
 *
 * The subscription row is upserted into platform.subscription by syncRegistrations() at boot.
 * The worker must be given the transactional db via runtime options (see runtime.ts).
 */
export function subscribe<E extends EventType>(
  type: E,
  handlerName: string,
  fn: EventHandlerFn<EventPayload<E>>,
  opts: SubscribeOptions = {},
): void {
  if (typeof type !== 'string' || !JOB_TYPE_RE.test(type)) throw new AppError('VALIDATION', `Invalid event type "${String(type)}"`);
  if (!NAME_RE.test(handlerName)) throw new AppError('VALIDATION', `Invalid handler name "${handlerName}"`);
  const queue = opts.queue ?? 'serving';
  assertQueue(queue);
  addSubscription({ eventType: type, handler: handlerName, queue });
  registerHandler(eventJobType(type, handlerName), eventJobSchema, async (p, meta) => {
    const db = eventTxProvider();
    await db.transaction().execute(async (tx: Tx) => {
      const fresh = await markEventHandled(tx, p.eventId, handlerName);
      if (!fresh) {
        log.debug({ eventId: p.eventId, handler: handlerName }, 'event already handled; skipping');
        return;
      }
      let payload: unknown = p.payload;
      const schema = getEventSchema(type);
      if (schema) {
        const parsed = schema.safeParse(payload);
        if (!parsed.success) throw new NonRetryable(`event ${type} payload failed schema validation: ${parsed.error.message}`);
        payload = parsed.data;
      }
      await fn(payload as EventPayload<E>, {
        eventId: p.eventId as Id<'event'>,
        eventType: p.eventType,
        correlationId: meta.correlationId,
        tx,
        job: meta,
      });
    });
  });
}

// The db used to open event-handler transactions. Set by the runtime at start so this file
// does not call systemDb() (which logs) on every event.
let eventDb: Tx | undefined;

export function setEventDb(db: Tx | undefined): void {
  eventDb = db;
}

function eventTxProvider(): Tx {
  if (!eventDb) throw new AppError('INTERNAL', 'Queue runtime not started: no database for event handlers');
  return eventDb;
}
