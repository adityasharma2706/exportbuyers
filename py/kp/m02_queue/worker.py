"""M02 — knowledge-plane (R3) queue runtime. Mirror of apps/web/src/modules/m02_queue/runtime.ts.

The same Postgres tables, SQL, lease/backoff rules and advisory-lock keys as the TS runtime,
so either plane can run the leader duties (dispatcher, scheduler, reaper, stale alerts).
"""
from __future__ import annotations

import json
import random
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import AbstractContextManager
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from kp.m01_platform import KpError, correlation, get_logger, get_secret, span

from .backoff import backoff_ms
from .cron import CronSpec, parse_cron, previous_fire
from .queue import (
    DeadLetterInfo,
    EventMeta,
    JobMeta,
    NonRetryable,
    QueueName,
    enqueue,
    event_job_type,
    fire_dead_letter,
    fire_stale_jobs,
    registries,
    validate_payload,
)

_log = get_logger("kp.m02_queue.worker")

LEASE_SECONDS = 300
HEARTBEAT_SECONDS = 60
RATE_CLASS_REFRESH_SECONDS = 30
OUTBOX_BATCH = 200
SCHEDULE_LOOKBACK = timedelta(hours=24)
RATE_KEY_PREFIX = "m02:rate:"

# Shared with runtime.ts LOCK_KEYS — keep in sync.
LOCK_DISPATCHER = 0x4D300201
LOCK_SCHEDULER = 0x4D300202
LOCK_REAPER = 0x4D300203
LOCK_STALE = 0x4D300204

TOKEN_BUCKET_LUA = """
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local d = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(burst, tokens + elapsed / 1000 * rate)
local ok = 0
if tokens >= 1 then
  tokens = tokens - 1
  ok = 1
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, math.ceil(burst / rate * 1000) + 1000)
return ok
"""

# A factory returning a context manager that yields a psycopg connection and commits on a
# clean exit (psycopg_pool.ConnectionPool.connection has exactly this contract).
ConnectionFactory = Callable[[], AbstractContextManager[Any]]

_JOB_COLS = (
    "id, queue, type, payload, v, idempotency_key, correlation_id, actor_ref, rate_class, state, "
    "attempts, max_attempts, run_at, locked_until, last_error, created_at"
)


def _row_to_job(cols: list[str], row: Any) -> dict[str, Any]:
    return dict(zip(cols, row))


def _err_text(e: BaseException) -> str:
    return f"{type(e).__name__}: {e}"[:4000]


def take_token(redis_client: Any, name: str, per_second: float, now_ms: int | None = None) -> bool:
    """Token bucket per rate class. Falls back to a SET NX PX slot limiter without EVAL."""
    if per_second <= 0:
        return True
    key = RATE_KEY_PREFIX + name
    burst = max(1, int(-(-per_second // 1)))
    if hasattr(redis_client, "eval"):
        return int(redis_client.eval(TOKEN_BUCKET_LUA, 1, key, str(per_second), str(burst))) == 1
    interval = max(1, int(-(-1000 // per_second)))
    now = int(time.time() * 1000) if now_ms is None else now_ms
    return bool(redis_client.set(f"{key}:slot:{now // interval}", "1", px=interval * 2, nx=True))


def sync_registrations(conn: Any) -> None:
    """Upserts schedules, subscriptions and rate classes registered in this process."""
    reg = registries()
    for s in reg.schedules.values():
        conn.execute(
            """insert into platform.schedule (name, cron, job_type, payload, queue) values (%s, %s, %s, %s::jsonb, %s)
               on conflict (name) do update set cron = excluded.cron, job_type = excluded.job_type,
                 payload = excluded.payload, queue = excluded.queue, updated_at = now()""",
            (s["name"], s["cron"], s["job_type"], json.dumps(s["payload"]), s["queue"]),
        )
    for (event_type, handler), queue in reg.subscriptions.items():
        conn.execute(
            """insert into platform.subscription (event_type, handler, queue) values (%s, %s, %s)
               on conflict (event_type, handler) do update set queue = excluded.queue, updated_at = now()""",
            (event_type, handler, queue),
        )
    for name, (max_conc, per_sec) in reg.rate_classes.items():
        conn.execute(
            """insert into platform.rate_class (name, max_concurrency, per_second) values (%s, %s, %s)
               on conflict (name) do update set max_concurrency = excluded.max_concurrency,
                 per_second = excluded.per_second, updated_at = now()""",
            (name, max_conc, per_sec),
        )


class QueueWorker:
    def __init__(
        self,
        queue: QueueName = "knowledge",
        *,
        connect: ConnectionFactory | None = None,
        redis_client: Any = None,
        concurrency: int = 4,
        poll_interval: float = 1.0,
        leader: bool = True,
        dispatch_interval: float = 0.5,
        scheduler_interval: float = 30.0,
        reaper_interval: float = 30.0,
        stale_check_interval: float = 300.0,
        stale_after_seconds: int = 3600,
        rnd: Callable[[], float] = random.random,
    ) -> None:
        if queue not in ("serving", "knowledge"):
            raise KpError("VALIDATION", f'QueueWorker: unknown queue "{queue}"')
        self.queue = queue
        self._connect = connect or self._default_pool()
        self._redis = redis_client
        self.concurrency = max(1, concurrency)
        self.poll_interval = poll_interval
        self.leader = leader
        self.intervals = {
            "dispatcher": dispatch_interval,
            "scheduler": scheduler_interval,
            "reaper": reaper_interval,
            "stale": stale_check_interval,
        }
        self.stale_after_seconds = stale_after_seconds
        self._rnd = rnd
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._pool: ThreadPoolExecutor | None = None
        self._inflight: set[Future[None]] = set()
        self._inflight_lock = threading.Lock()
        self._rate_classes: dict[str, tuple[int, float]] = {}
        self._rate_loaded_at = 0.0
        self._cron_cache: dict[str, CronSpec | None] = {}
        self._stale_alerted: dict[str, float] = {}

    @staticmethod
    def _default_pool() -> ConnectionFactory:
        from psycopg_pool import ConnectionPool

        pool = ConnectionPool(get_secret("DATABASE_URL"), min_size=1, max_size=8, open=True)
        return pool.connection

    def _redis_client(self) -> Any:
        if self._redis is None:
            import redis

            self._redis = redis.Redis.from_url(get_secret("REDIS_URL"), socket_timeout=2, decode_responses=True)
        return self._redis

    # ---- lifecycle ------------------------------------------------------------------

    def start(self) -> None:
        if self._threads:
            return
        with self._connect() as conn:
            sync_registrations(conn)
        self._stop.clear()
        self._pool = ThreadPoolExecutor(max_workers=self.concurrency, thread_name_prefix=f"m02-{self.queue}")
        self._spawn("worker", self._worker_loop)
        if self.leader:
            self._spawn("dispatcher", lambda: self._every("dispatcher", self.dispatch_once))
            self._spawn("scheduler", lambda: self._every("scheduler", self.schedule_once))
            self._spawn("reaper", lambda: self._every("reaper", self.reap_once))
            self._spawn("stale", lambda: self._every("stale", self.stale_check_once))
        _log.info("queue worker started", extra={"queue": self.queue, "leader": self.leader})

    def stop(self, timeout: float = 30.0) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout)
        self._threads.clear()
        if self._pool:
            self._pool.shutdown(wait=True)
            self._pool = None
        _log.info("queue worker stopped", extra={"queue": self.queue})

    def _spawn(self, name: str, target: Callable[[], None]) -> None:
        t = threading.Thread(target=target, name=f"m02-{name}", daemon=True)
        t.start()
        self._threads.append(t)

    def _every(self, name: str, fn: Callable[[], Any]) -> None:
        while not self._stop.is_set():
            try:
                fn()
            except Exception:  # noqa: BLE001 — keep the loop alive
                _log.exception("queue leader loop iteration failed", extra={"loop": name})
            self._stop.wait(self.intervals[name])

    # ---- worker ---------------------------------------------------------------------

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            claimed = 0
            try:
                claimed = self.poll_once()
            except Exception:  # noqa: BLE001
                _log.exception("queue poll failed", extra={"queue": self.queue})
            if claimed == 0:
                self._stop.wait(self.poll_interval)

    def poll_once(self, run_inline: bool = False) -> int:
        with self._inflight_lock:
            capacity = self.concurrency - len(self._inflight)
        types = list(registries().handlers)
        if capacity <= 0 or not types:
            if capacity <= 0:
                time.sleep(0.05)
            return 0
        with self._connect() as conn:
            cur = conn.execute(
                f"""with c as (
                      select id from platform.job
                       where queue = %s and state = 'queued' and run_at <= now() and type = any(%s)
                       order by run_at limit %s for update skip locked)
                    update platform.job j
                       set state = 'running', attempts = j.attempts + 1,
                           locked_until = now() + make_interval(secs => %s), updated_at = now()
                      from c where j.id = c.id
                    returning {', '.join('j.' + c.strip() for c in _JOB_COLS.split(','))}""",
                (self.queue, types, capacity, LEASE_SECONDS),
            )
            cols = [d.name for d in cur.description]
            jobs = [_row_to_job(cols, r) for r in cur.fetchall()]
        for job in jobs:
            if run_inline or self._pool is None:
                self._safe_run(job)
                continue
            fut = self._pool.submit(self._safe_run, job)
            with self._inflight_lock:
                self._inflight.add(fut)
            fut.add_done_callback(self._done)
        return len(jobs)

    def _done(self, fut: Future[None]) -> None:
        with self._inflight_lock:
            self._inflight.discard(fut)

    def _safe_run(self, job: dict[str, Any]) -> None:
        try:
            self.run_job(job)
        except Exception:  # noqa: BLE001
            _log.exception("unexpected error while running job", extra={"job_id": str(job["id"])})

    def _fenced(self, sql: str, params: tuple[Any, ...]) -> bool:
        with self._connect() as conn:
            return conn.execute(sql + " returning id", params).fetchone() is not None

    def _defer(self, job: dict[str, Any], delay_ms: int) -> bool:
        return self._fenced(
            """update platform.job set state = 'queued', locked_until = null, attempts = greatest(attempts - 1, 0),
                 run_at = now() + make_interval(secs => %s), updated_at = now()
               where id = %s and state = 'running' and attempts = %s""",
            (delay_ms / 1000, job["id"], job["attempts"]),
        )

    def _kill(self, job: dict[str, Any], error: str, reason: Any) -> None:
        ok = self._fenced(
            """update platform.job set state = 'dead', locked_until = null, last_error = %s, updated_at = now()
               where id = %s and state = 'running' and attempts = %s""",
            (error, job["id"], job["attempts"]),
        )
        if ok:
            fire_dead_letter(self._dead_info(job, error, reason))
        else:
            _log.warning("lost the lease before dead-lettering the job", extra={"job_id": str(job["id"])})

    @staticmethod
    def _dead_info(job: dict[str, Any], error: str, reason: Any) -> DeadLetterInfo:
        return DeadLetterInfo(
            job_id=str(job["id"]), type=job["type"], queue=job["queue"], payload=job["payload"],
            attempts=job["attempts"], max_attempts=job["max_attempts"], last_error=error,
            correlation_id=job["correlation_id"], actor_ref=job["actor_ref"], reason=reason,
        )

    def _rate_delay(self, job: dict[str, Any]) -> int | None:
        name = job.get("rate_class")
        if not name:
            return None
        if time.monotonic() - self._rate_loaded_at > RATE_CLASS_REFRESH_SECONDS:
            with self._connect() as conn:
                rows = conn.execute("select name, max_concurrency, per_second from platform.rate_class").fetchall()
            self._rate_classes = {r[0]: (int(r[1]), float(r[2])) for r in rows}
            self._rate_loaded_at = time.monotonic()
        rc = self._rate_classes.get(name)
        if rc is None:
            _log.warning("unknown rate class; running unthrottled", extra={"rate_class": name})
            return None
        max_conc, per_sec = rc
        with self._connect() as conn:
            running = conn.execute(
                "select count(*) from platform.job where state = 'running' and rate_class = %s", (name,)
            ).fetchone()[0]
        if int(running) > max_conc:
            return int(1000 * (0.5 + self._rnd()))
        if take_token(self._redis_client(), name, per_sec):
            return None
        return max(1, int(-(-1000 // per_sec)))

    def run_job(self, job: dict[str, Any]) -> None:
        handler = registries().handlers.get(job["type"])
        if handler is None:
            self._defer(job, 0)
            return
        delay = self._rate_delay(job)
        if delay is not None:
            self._defer(job, delay)
            return
        try:
            data = validate_payload(handler.schema, job["payload"])
        except Exception as e:  # noqa: BLE001 — invalid payload is non-retryable
            self._kill(job, f"invalid payload: {e}"[:4000], "invalid_payload")
            return

        meta = JobMeta(
            job_id=str(job["id"]), type=job["type"], queue=job["queue"], attempt=job["attempts"],
            max_attempts=job["max_attempts"], correlation_id=job["correlation_id"], actor_ref=job["actor_ref"],
            idempotency_key=job["idempotency_key"], v=job["v"], enqueued_at=job.get("created_at"),
        )
        stop_hb = threading.Event()
        hb = threading.Thread(target=self._heartbeat, args=(job, stop_hb), daemon=True)
        hb.start()
        try:
            with correlation(job["correlation_id"]), span(f"job {job['type']}", {"job.id": str(job["id"]), "job.attempt": job["attempts"]}):
                if handler.event is not None:
                    self._run_event(handler.event, handler.fn, data, meta)
                else:
                    handler.fn(data, meta)
        except Exception as e:  # noqa: BLE001
            stop_hb.set()
            msg = _err_text(e)
            if isinstance(e, NonRetryable):
                self._kill(job, msg, "non_retryable")
            elif job["attempts"] >= job["max_attempts"]:
                self._kill(job, msg, "max_attempts")
            else:
                wait = backoff_ms(job["attempts"], self._rnd())
                _log.warning("job failed; will retry", extra={"job_id": str(job["id"]), "retry_in_ms": wait, "error": msg})
                self._fenced(
                    """update platform.job set state = 'queued', locked_until = null, last_error = %s,
                         run_at = now() + make_interval(secs => %s), updated_at = now()
                       where id = %s and state = 'running' and attempts = %s""",
                    (msg, wait / 1000, job["id"], job["attempts"]),
                )
            return
        finally:
            stop_hb.set()
        if not self._fenced(
            """update platform.job set state = 'done', locked_until = null, updated_at = now()
               where id = %s and state = 'running' and attempts = %s""",
            (job["id"], job["attempts"]),
        ):
            _log.warning("job finished after its lease was lost", extra={"job_id": str(job["id"])})

    def _run_event(self, event: tuple[str, str], fn: Callable[..., None], env: dict[str, Any], meta: JobMeta) -> None:
        event_type, handler_name = event
        with self._connect() as conn:  # commits on clean exit, rolls back on exception
            fresh = conn.execute(
                """insert into platform.event_handled (event_id, handler) values (%s::uuid, %s)
                   on conflict (event_id, handler) do nothing returning event_id""",
                (env["eventId"], handler_name),
            ).fetchone()
            if fresh is None:
                _log.debug("event already handled; skipping", extra={"event_id": env["eventId"], "handler": handler_name})
                return
            payload = env["payload"]
            schema = registries().event_schemas.get(event_type)
            if schema is not None:
                try:
                    payload = validate_payload(schema, payload)
                except Exception as e:  # noqa: BLE001
                    raise NonRetryable(f"event {event_type} payload failed schema validation: {e}") from e
            fn(payload, EventMeta(event_id=env["eventId"], event_type=env["eventType"],
                                  correlation_id=meta.correlation_id, tx=conn, job=meta))

    def _heartbeat(self, job: dict[str, Any], stop: threading.Event) -> None:
        while not stop.wait(HEARTBEAT_SECONDS):
            try:
                ok = self._fenced(
                    """update platform.job set locked_until = now() + make_interval(secs => %s), updated_at = now()
                       where id = %s and state = 'running' and attempts = %s""",
                    (LEASE_SECONDS, job["id"], job["attempts"]),
                )
                if not ok:
                    _log.warning("job lease lost while running", extra={"job_id": str(job["id"])})
                    return
            except Exception:  # noqa: BLE001
                _log.warning("lease heartbeat failed", extra={"job_id": str(job["id"])}, exc_info=True)

    # ---- leader duties --------------------------------------------------------------

    def _as_leader(self, key: int, fn: Callable[[Any], Any]) -> Any:
        with self._connect() as conn:
            got = conn.execute("select pg_try_advisory_xact_lock(%s::bigint)", (key,)).fetchone()[0]
            if not got:
                return None
            return fn(conn)

    def dispatch_once(self) -> int:
        def run(conn: Any) -> int:
            events = conn.execute(
                """select id, event_type, payload, v from platform.outbox where dispatched_at is null
                   order by created_at limit %s for update skip locked""",
                (OUTBOX_BATCH,),
            ).fetchall()
            if not events:
                return 0
            types = list({e[1] for e in events})
            subs = conn.execute(
                "select event_type, handler, queue from platform.subscription where event_type = any(%s)", (types,)
            ).fetchall()
            for ev_id, ev_type, payload, v in events:
                for s_type, s_handler, s_queue in subs:
                    if s_type != ev_type:
                        continue
                    enqueue(
                        conn, type=event_job_type(ev_type, s_handler), queue=s_queue,
                        payload={"eventId": str(ev_id), "eventType": ev_type, "v": v, "payload": payload},
                        idempotency_key=f"{ev_id}:{s_handler}", v=v,
                    )
            conn.execute("update platform.outbox set dispatched_at = now() where id = any(%s)", ([e[0] for e in events],))
            return len(events)

        return self._as_leader(LOCK_DISPATCHER, run) or 0

    def _cron(self, expr: str) -> CronSpec | None:
        if expr not in self._cron_cache:
            try:
                self._cron_cache[expr] = parse_cron(expr)
            except KpError:
                _log.error("invalid cron expression in platform.schedule", extra={"cron": expr})
                self._cron_cache[expr] = None
        return self._cron_cache[expr]

    def schedule_once(self, now: datetime | None = None) -> int:
        now = now or datetime.now(timezone.utc)

        def run(conn: Any) -> int:
            rows = conn.execute(
                """select name, cron, job_type, payload, queue, last_enqueued_at from platform.schedule
                   order by name for update skip locked"""
            ).fetchall()
            fired = 0
            for name, cron, job_type, payload, queue, last in rows:
                spec = self._cron(cron)
                if spec is None:
                    continue
                if last is not None:
                    frm = max(last, now - SCHEDULE_LOOKBACK)
                else:
                    frm = now - timedelta(seconds=2 * self.intervals["scheduler"])
                due = previous_fire(spec, now, frm)
                if due is None:
                    continue
                enqueue(conn, type=job_type, queue=queue, payload=payload or {},
                        idempotency_key=f"{name}:{_iso_ms(due)}")
                conn.execute(
                    "update platform.schedule set last_enqueued_at = %s, updated_at = now() where name = %s", (due, name)
                )
                fired += 1
            return fired

        return self._as_leader(LOCK_SCHEDULER, run) or 0

    def reap_once(self) -> int:
        def run(conn: Any) -> list[dict[str, Any]]:
            cur = conn.execute(
                f"""with expired as (
                      select id from platform.job where state = 'running' and locked_until < now()
                       order by locked_until limit 500 for update skip locked)
                    update platform.job j
                       set state = case when j.attempts >= j.max_attempts then 'dead' else 'queued' end,
                           run_at = now(), locked_until = null,
                           last_error = 'lease expired during attempt ' || j.attempts, updated_at = now()
                      from expired where j.id = expired.id
                    returning {', '.join('j.' + c.strip() for c in _JOB_COLS.split(','))}"""
            )
            cols = [d.name for d in cur.description]
            return [_row_to_job(cols, r) for r in cur.fetchall()]

        reaped = self._as_leader(LOCK_REAPER, run) or []
        for job in reaped:
            if job["state"] == "dead":
                fire_dead_letter(self._dead_info(job, job["last_error"] or "lease expired", "lease_expired"))
            else:
                _log.warning("job lease expired; requeued", extra={"job_id": str(job["id"])})
        return len(reaped)

    def stale_check_once(self) -> int:
        def run(conn: Any) -> list[Any]:
            return conn.execute(
                """select type, queue, count(*)::int, min(run_at) from platform.job
                   where state = 'queued' and run_at < now() - make_interval(secs => %s)
                   group by type, queue""",
                (self.stale_after_seconds,),
            ).fetchall()

        rows = self._as_leader(LOCK_STALE, run) or []
        alerted = 0
        now = time.monotonic()
        for jtype, queue, count, oldest in rows:
            key = f"{queue}:{jtype}"
            if now - self._stale_alerted.get(key, -1e18) < self.stale_after_seconds:
                continue
            self._stale_alerted[key] = now
            fire_stale_jobs({"type": jtype, "queue": queue, "count": int(count), "oldest_run_at": str(oldest)})
            alerted += 1
        return alerted


def _iso_ms(d: datetime) -> str:
    """ISO-8601 in UTC with millisecond precision and a Z suffix — identical to JS toISOString()."""
    d = d.astimezone(timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"
