-- M38 User data rights (LLD M38). REQ-061.
--
-- serving.rights_request tracks one DPDP request (export or erase) per account. Account-scoped
-- (account_id), so it gets the usual tenant RLS policy; the erase/export background jobs still
-- write it through systemDb() (the request is created by a signed-in member, but the job that
-- finishes it runs without an HTTP request), the same pattern M35's serving.export uses.

-- migrate:up

create table serving.rights_request (
  id            uuid primary key,
  account_id    uuid not null references serving.account (id),
  kind          text not null check (kind in ('export', 'erase')),
  state         text not null check (state in ('queued', 'running', 'done', 'failed')) default 'queued',
  zip_s3_key    text null,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz null
);
create index rights_request_account_created_idx on serving.rights_request (account_id, created_at desc);
select platform.enable_tenant_rls('serving.rights_request'::regclass, false);

-- migrate:down

drop table if exists serving.rights_request;
