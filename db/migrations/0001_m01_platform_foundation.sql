-- M01 Platform foundation. dbmate migration, run as app_admin against Postgres 16 in ap-south-1.
-- Shared by the TS app (apps/web) and the Python knowledge plane (py/kp).

-- migrate:up

-- Extensions -------------------------------------------------------------------------
create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists citext;

-- Schemas ----------------------------------------------------------------------------
create schema if not exists serving;
create schema if not exists knowledge;
create schema if not exists ledger;
create schema if not exists analytics;
create schema if not exists platform;   -- queue, outbox, cost tables

-- Roles ------------------------------------------------------------------------------
-- Group roles only (NOLOGIN). Login users with passwords are created by infrastructure from
-- the secrets manager and granted these roles, so no credential ever lives in the repo.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_serving') then
    create role app_serving nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_knowledge') then
    create role app_knowledge nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_admin') then
    create role app_admin nologin;
  end if;
end
$roles$;

revoke all on schema serving, knowledge, ledger, analytics, platform from public;

-- app_serving: read/write serving, ledger, platform. Knowledge access is SELECT on the
-- read-model views only; those grants are issued by M09's migration, not here.
grant usage on schema serving, ledger, platform to app_serving;
grant usage on schema knowledge to app_serving;
grant select, insert, update, delete on all tables in schema serving, ledger, platform to app_serving;
grant usage, select on all sequences in schema serving, ledger, platform to app_serving;
alter default privileges in schema serving, ledger, platform
  grant select, insert, update, delete on tables to app_serving;
alter default privileges in schema serving, ledger, platform
  grant usage, select on sequences to app_serving;

-- app_knowledge: read/write knowledge and analytics. Read access to knowledge.suppression
-- is granted by the migration that creates that table. It may also record costs.
grant usage on schema knowledge, analytics, platform to app_knowledge;
grant select, insert, update, delete on all tables in schema knowledge, analytics to app_knowledge;
grant usage, select on all sequences in schema knowledge, analytics to app_knowledge;
alter default privileges in schema knowledge, analytics
  grant select, insert, update, delete on tables to app_knowledge;
alter default privileges in schema knowledge, analytics
  grant usage, select on sequences to app_knowledge;

-- Tenant RLS helpers -----------------------------------------------------------------
-- The TS scoped() helper stamps each connection with app.account_id / app.workspace_id
-- (and SET LOCAL inside transactions). systemDb() sets app.rls_bypass = 'on'.
-- RLS is defence in depth against application bugs: the app role can set these GUCs, so it
-- is not a boundary against a compromised application.
create or replace function platform.current_account_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;

create or replace function platform.current_workspace_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;

create or replace function platform.rls_bypass() returns boolean
  language sql stable
  as $$ select coalesce(current_setting('app.rls_bypass', true), '') = 'on' $$;

-- Called by each owning module's migration for every account/workspace-scoped table:
--   select platform.enable_tenant_rls('serving.workspace'::regclass, false);
create or replace function platform.enable_tenant_rls(tbl regclass, workspace_scoped boolean default false)
  returns void
  language plpgsql
  as $fn$
declare
  pred text;
begin
  if workspace_scoped then
    pred := 'platform.rls_bypass() or (account_id = platform.current_account_id() '
         || 'and workspace_id = platform.current_workspace_id())';
  else
    pred := 'platform.rls_bypass() or account_id = platform.current_account_id()';
  end if;
  execute format('alter table %s enable row level security', tbl);
  execute format('alter table %s force row level security', tbl);
  execute format('drop policy if exists tenant_isolation on %s', tbl);
  execute format('create policy tenant_isolation on %s using (%s) with check (%s)', tbl, pred, pred);
end
$fn$;

grant execute on function platform.current_account_id(), platform.current_workspace_id(), platform.rls_bypass()
  to app_serving, app_knowledge;

-- Cost metrics (IF-01b) ---------------------------------------------------------------
create table platform.cost_event (
  id              uuid primary key,
  vendor          text not null,
  op              text not null,
  units           numeric not null check (units >= 0),
  cost_micros_inr bigint not null check (cost_micros_inr >= 0),
  job_type        text,
  account_id      uuid null,
  credit_ref      text null,
  correlation_id  text not null,
  at              timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index cost_event_vendor_at_idx  on platform.cost_event (vendor, at);
create index cost_event_account_at_idx on platform.cost_event (account_id, at) where account_id is not null;
create index cost_event_job_type_at_idx on platform.cost_event (job_type, at) where job_type is not null;

create table platform.budget (
  vendor                  text primary key,
  monthly_limit_micros_inr bigint check (monthly_limit_micros_inr is null or monthly_limit_micros_inr >= 0),
  alert_pct               int not null default 80 check (alert_pct between 1 and 100),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

grant select, insert on platform.cost_event to app_knowledge;
grant select on platform.budget to app_knowledge;

-- migrate:down

drop table if exists platform.budget;
drop table if exists platform.cost_event;
drop function if exists platform.enable_tenant_rls(regclass, boolean);
drop function if exists platform.rls_bypass();
drop function if exists platform.current_workspace_id();
drop function if exists platform.current_account_id();
-- Schemas, extensions and roles are left in place: dropping them would destroy other
-- modules' data. Remove them manually when decommissioning an environment.
