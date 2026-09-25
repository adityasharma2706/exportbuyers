/**
 * M02 Job queue and scheduler — public API. Other modules import ONLY from this file.
 *
 * IF-02a enqueue(tx, job, ctx?), registerHandler(type, schema, fn)
 * IF-02b registerSchedule(name, cron, jobType, payload, queue)
 * IF-02c emit(tx, type, payload), subscribe(type, handlerName, fn)
 *
 * Postgres-backed (platform.job, FOR UPDATE SKIP LOCKED) and shared with the Python
 * knowledge plane (py/kp/m02_queue). The R2 worker process starts the runtime with
 * `startQueueRuntime({ queue: 'serving' })`.
 */
export type {
  DeadLetterHook,
  DeadLetterInfo,
  EnqueueJob,
  EventHandlerFn,
  EventMeta,
  EventPayload,
  EventRegistry,
  EventType,
  JobHandlerFn,
  JobMeta,
  JobState,
  PayloadSchema,
  QueueName,
  StaleJobAlert,
  StaleJobHook,
  Tx,
} from './types.js';
export { NonRetryable, QUEUE_NAMES, isNonRetryable } from './types.js';
export { DEFAULT_MAX_ATTEMPTS, actorRefOf, emit, enqueue, subscribe } from './queue.js';
export type { EventJobPayload, SubscribeOptions } from './queue.js';
export {
  eventJobType,
  onDeadLetter,
  onStaleJobs,
  registerEventSchema,
  registerHandler,
  registerRateClass,
  registerSchedule,
  resetRegistriesForTesting,
} from './registry.js';
export { QueueRuntime, LOCK_KEYS, startQueueRuntime, syncRegistrations } from './runtime.js';
export type { QueueRuntimeOptions } from './runtime.js';
export { BACKOFF_BASE_MS, BACKOFF_CAP_MS, BACKOFF_JITTER, backoffMs } from './backoff.js';
export { cronMatches, isValidCron, nextFire, parseCron, previousFire } from './cron.js';
export type { CronSpec } from './cron.js';
export type { RateClass } from './rate.js';
export { LEASE_SECONDS } from './repo.js';
