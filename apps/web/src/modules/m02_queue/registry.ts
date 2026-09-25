/**
 * M02 — in-process registries: job handlers, event subscriptions, schedules, rate classes,
 * event schemas and hooks. Registrations happen at module load / boot; the schedule,
 * subscription and rate-class registries are upserted into Postgres by syncRegistrations().
 */
import { AppError, log } from '../m01_platform/index.js';
import { parseCron } from './cron.js';
import type { RateClass } from './rate.js';
import {
  QUEUE_NAMES,
  type DeadLetterHook,
  type DeadLetterInfo,
  type JobHandlerFn,
  type PayloadSchema,
  type QueueName,
  type StaleJobAlert,
  type StaleJobHook,
} from './types.js';

export const JOB_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

export interface RegisteredHandler {
  type: string;
  schema: PayloadSchema<unknown>;
  fn: JobHandlerFn<unknown>;
}

export interface RegisteredSchedule {
  name: string;
  cron: string;
  jobType: string;
  payload: object;
  queue: QueueName;
}

export interface RegisteredSubscription {
  eventType: string;
  handler: string;
  queue: QueueName;
}

const handlers = new Map<string, RegisteredHandler>();
const schedules = new Map<string, RegisteredSchedule>();
const subscriptions = new Map<string, RegisteredSubscription>();
const rateClasses = new Map<string, RateClass>();
const eventSchemas = new Map<string, PayloadSchema<unknown>>();
const deadLetterHooks: DeadLetterHook[] = [];
const staleJobHooks: StaleJobHook[] = [];

export function assertQueue(q: unknown): asserts q is QueueName {
  if (!QUEUE_NAMES.includes(q as QueueName)) {
    throw new AppError('VALIDATION', `Unknown queue "${String(q)}"; expected one of ${QUEUE_NAMES.join(', ')}`);
  }
}

export function assertJobType(type: string): void {
  if (typeof type !== 'string' || !JOB_TYPE_RE.test(type)) {
    throw new AppError('VALIDATION', `Invalid job type "${String(type)}"`);
  }
}

// ---- handlers --------------------------------------------------------------------------

export function registerHandler<P>(type: string, schema: PayloadSchema<P>, fn: JobHandlerFn<P>): void {
  assertJobType(type);
  if (!schema || typeof schema.safeParse !== 'function') {
    throw new AppError('VALIDATION', `registerHandler(${type}): schema must expose safeParse (e.g. a zod schema)`);
  }
  if (typeof fn !== 'function') throw new AppError('VALIDATION', `registerHandler(${type}): fn must be a function`);
  if (handlers.has(type)) throw new AppError('CONFLICT', `A handler for job type "${type}" is already registered`);
  handlers.set(type, {
    type,
    schema: schema as PayloadSchema<unknown>,
    fn: fn as JobHandlerFn<unknown>,
  });
}

export function getHandler(type: string): RegisteredHandler | undefined {
  return handlers.get(type);
}

export function registeredJobTypes(): string[] {
  return [...handlers.keys()];
}

// ---- schedules -------------------------------------------------------------------------

export function registerSchedule(name: string, cron: string, jobType: string, payload: object, queue: QueueName): void {
  if (!NAME_RE.test(name)) throw new AppError('VALIDATION', `Invalid schedule name "${name}"`);
  parseCron(cron); // throws VALIDATION on a bad expression
  assertJobType(jobType);
  assertQueue(queue);
  if (payload === null || typeof payload !== 'object') {
    throw new AppError('VALIDATION', `registerSchedule(${name}): payload must be an object`);
  }
  const existing = schedules.get(name);
  if (existing && (existing.cron !== cron || existing.jobType !== jobType || existing.queue !== queue)) {
    throw new AppError('CONFLICT', `Schedule "${name}" is already registered with a different definition`);
  }
  schedules.set(name, { name, cron, jobType, payload, queue });
}

export function registeredSchedules(): RegisteredSchedule[] {
  return [...schedules.values()];
}

// ---- subscriptions & event schemas -----------------------------------------------------

export function eventJobType(eventType: string, handler: string): string {
  return `evt:${eventType}:${handler}`;
}

export function addSubscription(sub: RegisteredSubscription): void {
  const key = `${sub.eventType}\u0000${sub.handler}`;
  if (subscriptions.has(key)) {
    throw new AppError('CONFLICT', `Handler "${sub.handler}" is already subscribed to "${sub.eventType}"`);
  }
  subscriptions.set(key, sub);
}

export function registeredSubscriptions(): RegisteredSubscription[] {
  return [...subscriptions.values()];
}

export function registerEventSchema<P>(eventType: string, schema: PayloadSchema<P>): void {
  assertJobType(eventType);
  if (!schema || typeof schema.safeParse !== 'function') {
    throw new AppError('VALIDATION', `registerEventSchema(${eventType}): schema must expose safeParse`);
  }
  eventSchemas.set(eventType, schema as PayloadSchema<unknown>);
}

export function getEventSchema(eventType: string): PayloadSchema<unknown> | undefined {
  return eventSchemas.get(eventType);
}

// ---- rate classes ----------------------------------------------------------------------

/** Declares a rate class; upserted into platform.rate_class at boot. */
export function registerRateClass(name: string, maxConcurrency: number, perSecond: number): void {
  if (!NAME_RE.test(name)) throw new AppError('VALIDATION', `Invalid rate class name "${name}"`);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new AppError('VALIDATION', `Rate class ${name}: maxConcurrency must be an integer >= 1`);
  }
  if (!Number.isFinite(perSecond) || perSecond <= 0) {
    throw new AppError('VALIDATION', `Rate class ${name}: perSecond must be > 0`);
  }
  rateClasses.set(name, { name, maxConcurrency, perSecond });
}

export function registeredRateClasses(): RateClass[] {
  return [...rateClasses.values()];
}

// ---- hooks -----------------------------------------------------------------------------

/** M11 registers a hook here that files `system.dead_letter` (HLD assumption 9). */
export function onDeadLetter(fn: DeadLetterHook): () => void {
  deadLetterHooks.push(fn);
  return () => {
    const i = deadLetterHooks.indexOf(fn);
    if (i >= 0) deadLetterHooks.splice(i, 1);
  };
}

export async function fireDeadLetter(info: DeadLetterInfo): Promise<void> {
  log.error(
    { jobId: info.jobId, jobType: info.type, attempts: info.attempts, reason: info.reason, lastError: info.lastError },
    'job dead-lettered',
  );
  for (const h of [...deadLetterHooks]) {
    try {
      await h(info);
    } catch (err) {
      log.error({ err, jobId: info.jobId }, 'dead-letter hook failed');
    }
  }
}

/** Alert sink for queued jobs that nothing has picked up for over an hour (unknown type). */
export function onStaleJobs(fn: StaleJobHook): () => void {
  staleJobHooks.push(fn);
  return () => {
    const i = staleJobHooks.indexOf(fn);
    if (i >= 0) staleJobHooks.splice(i, 1);
  };
}

export async function fireStaleJobs(alert: StaleJobAlert): Promise<void> {
  log.error(
    { jobType: alert.type, queue: alert.queue, count: alert.count, oldestRunAt: alert.oldestRunAt.toISOString() },
    'queued jobs not picked up for over 1 h (no registered handler?)',
  );
  for (const h of [...staleJobHooks]) {
    try {
      await h(alert);
    } catch (err) {
      log.error({ err, jobType: alert.type }, 'stale-job hook failed');
    }
  }
}

/** Test helper: clears every registry and hook. */
export function resetRegistriesForTesting(): void {
  handlers.clear();
  schedules.clear();
  subscriptions.clear();
  rateClasses.clear();
  eventSchemas.clear();
  deadLetterHooks.length = 0;
  staleJobHooks.length = 0;
}
