-- M35 Export to Excel/CSV (LLD M35). REQ-048.
--
-- [deviation: the LLD's literal schema for serving.export lists
-- {id, account_id, source, format, state, row_count, s3_key, canary_ids, created_at, expires_at}.
-- Two columns are added here: (1) `company_ids uuid[]`, needed for the EV-04 handler's own rule
-- ("Delete ready files whose source contained a suppressed company. The check uses a company_ids
-- list kept alongside each export") -- the literal column list has nowhere to keep that list;
-- (2) `updated_at timestamptz`, tracked here the same way every other table in this codebase
-- tracks it across the same kind of state-machine transitions this row goes through (queued ->
-- running -> ready/failed/cancelled). Primary key and every column the LLD does list are
-- unchanged. Also: the LLD's job description writes files to "s3://exports/<acct>/<id>"; M01's
-- object store (storage.ts) exposes exactly one configured bucket (PlatformConfig.objectBucket),
-- not a bucket-per-purpose, so this module keys its objects "exports/<acct>/<id>.<ext>" inside
-- that one shared bucket instead of a dedicated "exports" bucket.]

-- migrate:up

create table serving.export (
  id           uuid primary key,
  account_id   uuid not null references serving.account (id),
  source       jsonb not null,
  format       text not null check (format in ('xlsx', 'csv')),
  state        text not null check (state in ('queued', 'running', 'ready', 'failed', 'cancelled')),
  row_count    integer null check (row_count is null or row_count >= 0),
  s3_key       text null,
  canary_ids   uuid[] not null default '{}',
  company_ids  uuid[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index export_account_created_idx on serving.export (account_id, created_at desc);
create index export_state_idx on serving.export (state);
create index export_company_ids_gin_idx on serving.export using gin (company_ids);
select platform.enable_tenant_rls('serving.export'::regclass, false);

-- migrate:down

drop table if exists serving.export;
