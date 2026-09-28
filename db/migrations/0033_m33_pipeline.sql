-- M33 Pipeline: shortlists, statuses and notes (LLD M33). REQ-045, REQ-046, REQ-008, REQ-047.
--
-- [deviation: the LLD's literal schema for serving.status_history and serving.note has no
-- account_id/workspace_id columns (only entry_id). Both are added here, the same deviation
-- M29's serving.reveal_contact migration takes for the same reason: M01's tenant RLS needs a
-- tenant column on every row it protects, and these child rows are looked up by (entry) id alone
-- on routes that carry no workspace segment in their URL (PATCH /api/shortlist/:id/notes).]

-- migrate:up

create table serving.shortlist_entry (
  id              uuid primary key,
  account_id      uuid not null references serving.account (id),
  workspace_id    uuid not null references serving.workspace (id),
  company_id      uuid not null,
  status          text not null default 'to_contact'
                    check (status in ('to_contact', 'contacted', 'replied', 'in_discussion', 'sample_sent', 'order_won', 'not_interested')),
  next_action_at  timestamptz null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, company_id)
);
create index shortlist_entry_account_idx on serving.shortlist_entry (account_id, created_at desc);
create index shortlist_entry_workspace_status_idx on serving.shortlist_entry (workspace_id, status);
select platform.enable_tenant_rls('serving.shortlist_entry'::regclass, false);

create table serving.status_history (
  id            uuid primary key,
  account_id    uuid not null references serving.account (id),
  workspace_id  uuid not null references serving.workspace (id),
  entry_id      uuid not null references serving.shortlist_entry (id),
  from_status   text null check (from_status is null or from_status in
                  ('to_contact', 'contacted', 'replied', 'in_discussion', 'sample_sent', 'order_won', 'not_interested')),
  to_status     text not null check (to_status in
                  ('to_contact', 'contacted', 'replied', 'in_discussion', 'sample_sent', 'order_won', 'not_interested')),
  source        text not null check (source in ('user', 'auto_draft')),
  at            timestamptz not null default now()
);
create index status_history_entry_idx on serving.status_history (entry_id, at desc);
select platform.enable_tenant_rls('serving.status_history'::regclass, false);

create table serving.note (
  id            uuid primary key,
  account_id    uuid not null references serving.account (id),
  workspace_id  uuid not null references serving.workspace (id),
  entry_id      uuid not null references serving.shortlist_entry (id),
  body          text not null check (length(body) <= 5000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index note_entry_created_idx on serving.note (entry_id, created_at asc);
select platform.enable_tenant_rls('serving.note'::regclass, false);

-- migrate:down

drop table if exists serving.note;
drop table if exists serving.status_history;
drop table if exists serving.shortlist_entry;
