-- M02 Job queue and scheduler. dbmate migration, run as app_admin.
-- A Postgres-backed queue that both the TS app (apps/web, R2 worker) and the Python knowledge
-- plane (py/kp, R3) read with SELECT ... FOR UPDATE SKIP LOCKED. There is no separate broker.

-- migrate:up

create table platform.job (
  id              uuid primary key,
  queue           text not null check (queue in ('serving', 'knowledge')),
  type            text not null check (length(type) between 1 and 200),
  payload         jsonb not null default '{}'::jsonb,
  v               int not null default 1,
  idempotency_key text not null check (length(idempotency_key) between 1 and 400),
  correlation_id  text not null,
  actor_ref       text,
  rate_class      text null,
  state           text not null default 'queued'
                  check (state in ('queued', 'running', 'done', 'failed', 'dead')),
  attempts        int not null default 0 check (attempts >= 0),
  max_attempts    int not null default 8 check (max_attempts between 1 and 100),
  run_at          timestamptz not null default now(),
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint job_type_idempotency_key_uq unique (type, idempotency_key)
);
-- Poll path: WHERE queue = $1 AND state = 'queued' AND run_at <= now() ORDER BY run_at.
create index job_queue_state_run_at_idx on platform.job (queue, state, run_at);
-- Reaper path: running jobs whose lease has expired.
create index job_running_locked_until_idx on platform.job (locked_until) where state = 'running';
-- Rate-class concurrency counting.
create index job_running_rate_class_idx on platform.job (rate_class) where state = 'running' and rate_class is not null;

create table platform.outbox (
  id             uuid primary key,
  event_type     text not null,
  payload        jsonb not null,
  v              int not null default 1,
  correlation_id text not null,
  created_at     timestamptz not null default now(),
  dispatched_at  timestamptz null
);
create index outbox_undispatched_idx on platform.outbox (created_at) where dispatched_at is null;

-- Seeded from code at boot (subscribe()).
create table platform.subscription (
  event_type text not null,
  handler    text not null,
  queue      text not null check (queue in ('serving', 'knowledge')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_type, handler)
);

-- Upserted at boot (registerSchedule()).
create table platform.schedule (
  name             text primary key,
  cron             text not null,
  job_type         text not null,
  payload          jsonb not null default '{}'::jsonb,
  queue            text not null check (queue in ('serving', 'knowledge')),
  last_enqueued_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table platform.rate_class (
  name            text primary key,
  max_concurrency int not null check (max_concurrency >= 1),
  per_second      numeric not null check (per_second > 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table platform.event_handled (
  event_id   uuid not null,
  handler    text not null,
  created_at timestamptz not null default now(),
  primary key (event_id, handler)
);

-- app_serving already has read/write on platform via default privileges (M01).
-- The knowledge plane polls its own queue, enqueues, emits and records handled events.
grant select, insert, update on platform.job to app_knowledge;
grant select, insert, update on platform.outbox to app_knowledge;
grant select, insert, update on platform.subscription to app_knowledge;
grant select, insert, update on platform.schedule to app_knowledge;
grant select, insert, update on platform.rate_class to app_knowledge;
grant select, insert on platform.event_handled to app_knowledge;

-- migrate:down

drop table if exists platform.event_handled;
drop table if exists platform.rate_class;
drop table if exists platform.schedule;
drop table if exists platform.subscription;
drop table if exists platform.outbox;
drop table if exists platform.job;
