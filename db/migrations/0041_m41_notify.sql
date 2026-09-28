-- M41 Reminders, notifications and dashboard (LLD M41). REQ-047, REQ-049.

-- migrate:up

create table serving.reminder (
  id          uuid primary key,
  account_id  uuid not null references serving.account (id),
  entry_id    uuid not null references serving.shortlist_entry (id),
  due_at      timestamptz not null,
  kind        text not null check (kind ~ '^[a-z][a-z0-9_]{0,49}$'),
  state       text not null default 'pending' check (state in ('pending', 'fired', 'done', 'snoozed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- Dashboard: "reminders due" for one account (LLD IF-41c: "the queries are indexed").
create index reminder_account_due_idx on serving.reminder (account_id, state, due_at);
-- Scheduler: system-wide sweep for `due_at <= now()` across every account (jobs.ts).
create index reminder_due_state_idx on serving.reminder (state, due_at);
select platform.enable_tenant_rls('serving.reminder'::regclass, false);

create table serving.notification (
  id          uuid primary key,
  account_id  uuid not null references serving.account (id),
  kind        text not null check (kind ~ '^[a-z][a-z0-9_]{0,49}$'),
  title_key   text not null,
  params      jsonb not null default '{}'::jsonb,
  company_id  uuid null,
  read_at     timestamptz null,
  created_at  timestamptz not null default now()
);
create index notification_account_created_idx on serving.notification (account_id, created_at desc);
select platform.enable_tenant_rls('serving.notification'::regclass, false);

create table serving.notify_pref (
  account_id  uuid primary key references serving.account (id),
  email       boolean not null default false,
  whatsapp    boolean not null default false,
  updated_at  timestamptz not null default now()
);
select platform.enable_tenant_rls('serving.notify_pref'::regclass, false);

-- migrate:down

drop table if exists serving.notify_pref;
drop table if exists serving.notification;
drop table if exists serving.reminder;
