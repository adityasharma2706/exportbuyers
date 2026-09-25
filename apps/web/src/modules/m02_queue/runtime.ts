/**
 * M02 — the queue runtime inside the R2 worker process.
 *
 * Worker loop  polls its own queue for types with a handler in this process, leases jobs for
 *              5 minutes (heartbeat extends the lease while the handler runs), applies rate
 *              classes, validates the payload, runs the handler and records the outcome.
 * Leader loops each tick runs in a transaction holding a pg advisory xact lock, so exactly
 *              one process performs it at a time:
 *                - dispatcher (500 ms): outbox → one `evt:<type>:<handler>` job per subscription
 *                - scheduler (30 s): cron evaluation, idempotency key `<name>:<scheduled_ts>`
 *                - reaper (30 s): requeues jobs whose lease expired
 *                - stale-job alert (5 min): queued jobs untouched for over 1 h
 */
import {
  AppError,
  getRedis,
  log,
  systemDb,
  withLogContext,
  withSpan,
  type Id,
  type RedisLike,
} from '../m01_platform/index.js';
import { backoffMs } from './backoff.js';
import { parseCron, previousFire, type CronSpec } from './cron.js';
import { enqueue, setEventDb } from './queue.js';
import { takeToken, tokenIntervalMs, type RateClass } from './rate.js';
import {
  eventJobType,
  fireDeadLetter,
  fireStaleJobs,
  getHandler,
  registeredJobTypes,
  registeredRateClasses,
  registeredSchedules,
  registeredSubscriptions,
} from './registry.js';
import {
  claimJobs,
  countRunningInClass,
  deferJob,
  extendLease,
  loadRateClasses,
  lockSchedules,
  lockUndispatchedOutbox,
  markDead,
  markDispatched,
  markDone,
  markRetry,
  reapExpired,
  setScheduleLastEnqueued,
  staleQueuedJobs,
  subscriptionsFor,
  tryXactLock,
  upsertRateClass,
  upsertSchedule,
  upsertSubscription,
} from './repo.js';
import { isNonRetryable, type DeadLetterInfo, type JobMeta, type JobRow, type QueueName, type Tx } from './types.js';

/** Advisory-lock keys (bigint). Shared with the Python runtime — keep in sync. */
export const LOCK_KEYS = Object.freeze({
  dispatcher: 0x4d30_0201,
  scheduler: 0x4d30_0202,
  reaper: 0x4d30_0203,
  staleAlert: 0x4d30_0204,
});

export interface QueueRuntimeOptions {
  queue: QueueName;
  /** Max handlers running at once in this process. Default 8. */
  concurrency?: number;
  /** Idle poll interval. Default 1000 ms. */
  pollIntervalMs?: number;
  /** Take part in leader duties (dispatcher, scheduler, reaper, alerts). Default true. */
  leader?: boolean;
  dispatchIntervalMs?: number; // default 500
  schedulerIntervalMs?: number; // default 30 000
  reaperIntervalMs?: number; // default 30 000
  staleCheckIntervalMs?: number; // default 300 000
  /** Queued jobs older than this raise a stale alert. Default 3600 s. */
  staleAfterSeconds?: number;
  /** Test hooks. */
  db?: Tx;
  redis?: RedisLike;
  random?: () => number;
}

const HEARTBEAT_MS = 60_000;
const RATE_CLASS_REFRESH_MS = 30_000;
const CONCURRENCY_RETRY_MS = 1_000;
const OUTBOX_BATCH = 200;
/** A schedule never backfills further than this; missed fires older than it are skipped. */
const SCHEDULE_LOOKBACK_MS = 24 * 3_600_000;

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(v);
}

function errorText(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.length > 4000 ? s.slice(0, 4000) : s;
}

/** Stop flag whose pending sleeps are woken immediately by stop(). */
class StopSignal {
  stopped = true;
  private readonly wakers = new Set<() => void>();

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      const done = (): void => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const w of [...this.wakers]) w();
  }
}

/** Upserts schedules, subscriptions and rate classes registered in this process. */
export async function syncRegistrations(db: Tx): Promise<void> {
  for (const s of registeredSchedules()) {
    await upsertSchedule(db, { name: s.name, cron: s.cron, jobType: s.jobType, payloadJson: JSON.stringify(s.payload), queue: s.queue });
  }
  for (const s of registeredSubscriptions()) {
    await upsertSubscription(db, s);
  }
  for (const rc of registeredRateClasses()) {
    await upsertRateClass(db, rc);
  }
}

export class QueueRuntime {
  private readonly opts: Required<Omit<QueueRuntimeOptions, 'db' | 'redis' | 'random'>>;
  private readonly db: Tx;
  private readonly redisOverride: RedisLike | undefined;
  private readonly random: () => number;
  private readonly signal = new StopSignal();
  private readonly inflight = new Set<Promise<void>>();
  private readonly loops: Promise<void>[] = [];
  private rateClasses = new Map<string, RateClass>();
  private rateClassesLoadedAt = 0;
  private readonly cronCache = new Map<string, CronSpec | null>();
  private readonly staleAlerted = new Map<string, number>();

  constructor(options: QueueRuntimeOptions) {
    if (options.queue !== 'serving' && options.queue !== 'knowledge') {
      throw new AppError('VALIDATION', `QueueRuntime: unknown queue "${String(options.queue)}"`);
    }
    this.opts = {
      queue: options.queue,
      concurrency: Math.max(1, Math.floor(options.concurrency ?? 8)),
      pollIntervalMs: options.pollIntervalMs ?? 1_000,
      leader: options.leader ?? true,
      dispatchIntervalMs: options.dispatchIntervalMs ?? 500,
      schedulerIntervalMs: options.schedulerIntervalMs ?? 30_000,
      reaperIntervalMs: options.reaperIntervalMs ?? 30_000,
      staleCheckIntervalMs: options.staleCheckIntervalMs ?? 300_000,
      staleAfterSeconds: options.staleAfterSeconds ?? 3_600,
    };
    this.db = options.db ?? systemDb(`m02 queue runtime (${options.queue})`);
    this.redisOverride = options.redis;
    this.random = options.random ?? Math.random;
  }

  get running(): boolean {
    return !this.signal.stopped;
  }

  async start(): Promise<void> {
    if (!this.signal.stopped) return;
    setEventDb(this.db);
    await syncRegistrations(this.db);
    this.signal.stopped = false;
    log.info({ queue: this.opts.queue, types: registeredJobTypes(), leader: this.opts.leader }, 'queue runtime started');
    this.loops.push(this.workerLoop());
    if (this.opts.leader) {
      this.loops.push(this.every(this.opts.dispatchIntervalMs, 'dispatcher', () => this.dispatchOnce()));
      this.loops.push(this.every(this.opts.schedulerIntervalMs, 'scheduler', () => this.scheduleOnce()));
      this.loops.push(this.every(this.opts.reaperIntervalMs, 'reaper', () => this.reapOnce()));
      this.loops.push(this.every(this.opts.staleCheckIntervalMs, 'stale-alert', () => this.staleCheckOnce()));
    }
  }

  /** Stops polling and waits for in-flight handlers to finish. */
  async stop(): Promise<void> {
    if (this.signal.stopped) return;
    this.signal.stop();
    await Promise.allSettled(this.loops);
    this.loops.length = 0;
    await Promise.allSettled([...this.inflight]);
    log.info({ queue: this.opts.queue }, 'queue runtime stopped');
  }

  private redis(): RedisLike {
    return this.redisOverride ?? getRedis();
  }

  private async every(intervalMs: number, name: string, fn: () => Promise<unknown>): Promise<void> {
    while (!this.signal.stopped) {
      try {
        await fn();
      } catch (err) {
        log.error({ err, loop: name }, 'queue leader loop iteration failed');
      }
      await this.signal.sleep(intervalMs);
    }
  }

  // ---- worker --------------------------------------------------------------------------

  private async workerLoop(): Promise<void> {
    while (!this.signal.stopped) {
      let claimed = 0;
      try {
        claimed = await this.pollOnce();
      } catch (err) {
        log.error({ err, queue: this.opts.queue }, 'queue poll failed');
      }
      if (this.inflight.size >= this.opts.concurrency) {
        await Promise.race([...this.inflight]);
      } else if (claimed === 0) {
        await this.signal.sleep(this.opts.pollIntervalMs);
      }
    }
  }

  /** Claims as many jobs as there is free capacity and starts them. Returns the number claimed. */
  async pollOnce(): Promise<number> {
    const capacity = this.opts.concurrency - this.inflight.size;
    if (capacity <= 0) return 0;
    const types = registeredJobTypes();
    if (types.length === 0) return 0;
    const jobs = await claimJobs(this.db, this.opts.queue, types, capacity);
    for (const job of jobs) {
      const p: Promise<void> = this.runJob(job)
        .catch((err: unknown) => log.error({ err, jobId: job.id }, 'unexpected error while running job'))
        .finally(() => {
          this.inflight.delete(p);
        });
      this.inflight.add(p);
    }
    return jobs.length;
  }

  /** Waits for every handler started so far (tests). */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private async rateClass(name: string): Promise<RateClass | undefined> {
    if (Date.now() - this.rateClassesLoadedAt > RATE_CLASS_REFRESH_MS) {
      const list = await loadRateClasses(this.db);
      this.rateClasses = new Map(list.map((rc) => [rc.name, rc]));
      this.rateClassesLoadedAt = Date.now();
    }
    return this.rateClasses.get(name);
  }

  /** Returns a delay in ms when the job must wait for its rate class, else null. */
  private async rateDelay(job: JobRow): Promise<number | null> {
    if (!job.rate_class) return null;
    const rc = await this.rateClass(job.rate_class);
    if (!rc) {
      log.warn({ jobId: job.id, rateClass: job.rate_class }, 'unknown rate class; running unthrottled');
      return null;
    }
    // Counted after our own claim committed, so it includes this job. Concurrent claimers
    // see each other and back off conservatively rather than overshooting.
    const running = await countRunningInClass(this.db, rc.name);
    if (running > rc.maxConcurrency) return Math.round(CONCURRENCY_RETRY_MS * (0.5 + this.random()));
    const ok = await takeToken(this.redis(), rc);
    return ok ? null : tokenIntervalMs(rc);
  }

  private meta(job: JobRow): JobMeta {
    return {
      jobId: job.id as Id<'job'>,
      type: job.type,
      queue: job.queue,
      attempt: job.attempts,
      maxAttempts: job.max_attempts,
      correlationId: job.correlation_id,
      actorRef: job.actor_ref,
      idempotencyKey: job.idempotency_key,
      v: job.v,
      enqueuedAt: toDate(job.created_at) ?? new Date(),
    };
  }

  private deadInfo(job: JobRow, lastError: string, reason: DeadLetterInfo['reason']): DeadLetterInfo {
    return {
      jobId: job.id as Id<'job'>,
      type: job.type,
      queue: job.queue,
      payload: job.payload,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      lastError,
      correlationId: job.correlation_id,
      actorRef: job.actor_ref,
      reason,
    };
  }

  private async kill(job: JobRow, error: string, reason: DeadLetterInfo['reason']): Promise<void> {
    if (await markDead(this.db, job.id, job.attempts, error)) {
      await fireDeadLetter(this.deadInfo(job, error, reason));
    } else {
      log.warn({ jobId: job.id }, 'lost the lease before dead-lettering the job');
    }
  }

  async runJob(job: JobRow): Promise<void> {
    const handler = getHandler(job.type);
    if (!handler) {
      // Should not happen: we only claim registered types. Put it back untouched.
      await deferJob(this.db, job.id, job.attempts, 0);
      return;
    }

    const delay = await this.rateDelay(job);
    if (delay !== null) {
      await deferJob(this.db, job.id, job.attempts, delay);
      return;
    }

    const parsed = handler.schema.safeParse(job.payload);
    if (!parsed.success) {
      await this.kill(job, `invalid payload: ${parsed.error.message}`.slice(0, 4000), 'invalid_payload');
      return;
    }

    const data: unknown = parsed.data;
    const meta = this.meta(job);
    const heartbeat = setInterval(() => {
      extendLease(this.db, job.id, job.attempts)
        .then((ok) => {
          if (!ok) log.warn({ jobId: job.id }, 'job lease lost while running');
        })
        .catch((err: unknown) => log.warn({ err, jobId: job.id }, 'lease heartbeat failed'));
    }, HEARTBEAT_MS);

    try {
      await withLogContext({ correlationId: job.correlation_id, jobType: job.type }, () =>
        withSpan(`job ${job.type}`, () => handler.fn(data, meta), {
          'job.id': job.id,
          'job.type': job.type,
          'job.attempt': job.attempts,
        }),
      );
    } catch (err) {
      clearInterval(heartbeat);
      const msg = errorText(err);
      if (isNonRetryable(err)) {
        await this.kill(job, msg, 'non_retryable');
      } else if (job.attempts >= job.max_attempts) {
        await this.kill(job, msg, 'max_attempts');
      } else {
        const wait = backoffMs(job.attempts, this.random());
        log.warn({ err, jobId: job.id, jobType: job.type, attempt: job.attempts, retryInMs: wait }, 'job failed; will retry');
        if (!(await markRetry(this.db, job.id, job.attempts, wait, msg))) {
          log.warn({ jobId: job.id }, 'lost the lease before scheduling a retry');
        }
      }
      return;
    }
    clearInterval(heartbeat);
    if (!(await markDone(this.db, job.id, job.attempts))) {
      log.warn({ jobId: job.id }, 'job finished after its lease was lost; outcome not recorded');
    }
  }

  // ---- leader duties -------------------------------------------------------------------

  private async asLeader<R>(key: number, fn: (tx: Tx) => Promise<R>): Promise<R | undefined> {
    return this.db.transaction().execute(async (tx: Tx) => {
      if (!(await tryXactLock(tx, key))) return undefined;
      return fn(tx);
    }) as Promise<R | undefined>;
  }

  /** Fans undispatched outbox rows out to subscriber jobs. Returns rows dispatched. */
  async dispatchOnce(): Promise<number> {
    const n = await this.asLeader(LOCK_KEYS.dispatcher, async (tx) => {
      const events = await lockUndispatchedOutbox(tx, OUTBOX_BATCH);
      if (events.length === 0) return 0;
      const subs = await subscriptionsFor(tx, [...new Set(events.map((e) => e.event_type))]);
      for (const e of events) {
        for (const s of subs) {
          if (s.event_type !== e.event_type) continue;
          await enqueue(tx, {
            type: eventJobType(e.event_type, s.handler),
            queue: s.queue,
            payload: { eventId: e.id, eventType: e.event_type, v: e.v, payload: e.payload },
            idempotencyKey: `${e.id}:${s.handler}`,
            v: e.v,
          });
        }
      }
      await markDispatched(tx, events.map((e) => e.id));
      return events.length;
    });
    return n ?? 0;
  }

  private cron(expr: string): CronSpec | null {
    if (!this.cronCache.has(expr)) {
      try {
        this.cronCache.set(expr, parseCron(expr));
      } catch (err) {
        log.error({ err, cron: expr }, 'invalid cron expression in platform.schedule');
        this.cronCache.set(expr, null);
      }
    }
    return this.cronCache.get(expr) ?? null;
  }

  /** Evaluates every schedule and enqueues due fires. Returns the number of jobs enqueued. */
  async scheduleOnce(now: Date = new Date()): Promise<number> {
    const n = await this.asLeader(LOCK_KEYS.scheduler, async (tx) => {
      const schedules = await lockSchedules(tx);
      let fired = 0;
      for (const s of schedules) {
        const spec = this.cron(s.cron);
        if (!spec) continue;
        const last = toDate(s.last_enqueued_at);
        const floor = now.getTime() - SCHEDULE_LOOKBACK_MS;
        // First evaluation: only fire a slot that fell inside the last two ticks.
        const from = last ? new Date(Math.max(last.getTime(), floor)) : new Date(now.getTime() - 2 * this.opts.schedulerIntervalMs);
        const due = previousFire(spec, now, from);
        if (!due) continue;
        await enqueue(tx, {
          type: s.job_type,
          queue: s.queue,
          payload: s.payload ?? {},
          idempotencyKey: `${s.name}:${due.toISOString()}`,
        });
        await setScheduleLastEnqueued(tx, s.name, due);
        fired++;
      }
      return fired;
    });
    return n ?? 0;
  }

  /** Requeues expired leases; dead-letters jobs out of attempts. */
  async reapOnce(): Promise<number> {
    const reaped = await this.asLeader(LOCK_KEYS.reaper, (tx) => reapExpired(tx));
    if (!reaped) return 0;
    for (const job of reaped) {
      if (job.state === 'dead') await fireDeadLetter(this.deadInfo(job, job.last_error ?? 'lease expired', 'lease_expired'));
      else log.warn({ jobId: job.id, jobType: job.type, attempt: job.attempts }, 'job lease expired; requeued');
    }
    return reaped.length;
  }

  /** Alerts (at most once per hour per type) on queued jobs nobody has picked up for 1 h. */
  async staleCheckOnce(): Promise<number> {
    const stale = await this.asLeader(LOCK_KEYS.staleAlert, (tx) => staleQueuedJobs(tx, this.opts.staleAfterSeconds));
    if (!stale) return 0;
    let alerted = 0;
    const nowMs = Date.now();
    for (const s of stale) {
      const key = `${s.queue}:${s.type}`;
      const lastAt = this.staleAlerted.get(key) ?? 0;
      if (nowMs - lastAt < this.opts.staleAfterSeconds * 1000) continue;
      this.staleAlerted.set(key, nowMs);
      await fireStaleJobs({ type: s.type, queue: s.queue, count: Number(s.count), oldestRunAt: toDate(s.oldest) ?? new Date(nowMs) });
      alerted++;
    }
    return alerted;
  }
}

/** Creates and starts a runtime for one queue (the R2 worker calls this with 'serving'). */
export async function startQueueRuntime(options: QueueRuntimeOptions): Promise<QueueRuntime> {
  const rt = new QueueRuntime(options);
  await rt.start();
  return rt;
}
