-- M07 Tenancy, business profile and onboarding (LLD M07). REQ-002, REQ-008; groundwork REQ-063, REQ-003.
-- Account → Members (M05) → Workspaces (Products). One business profile per account.

-- migrate:up

create table serving.business_profile (
  account_id         uuid primary key references serving.account (id),
  business_name      text not null check (length(btrim(business_name)) between 1 and 120),
  city               text null check (city is null or length(city) <= 80),
  state              text null check (state is null or length(state) <= 80),
  what_they_make     text null check (what_they_make is null or length(what_they_make) <= 300),
  export_experience  text null check (export_experience is null or export_experience in ('none', 'some', 'regular')),
  -- The application uppercases the IEC before validation (LLD M07 rule).
  iec                text null check (iec is null or iec ~ '^[A-Z0-9]{10}$'),
  -- Set by M49 (IEC verification) when the check returns `verified`; cleared when the IEC changes.
  iec_verified_at    timestamptz null,
  target_markets     text[] not null default '{}'
                       check (cardinality(target_markets) <= 20 and array_to_string(target_markets, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'),
  sender_name        text null check (sender_name is null or length(sender_name) <= 120),
  sender_email       citext null check (sender_email is null or sender_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  website            text null check (website is null or website ~* '^https?://'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
select platform.enable_tenant_rls('serving.business_profile'::regclass, false);

create table serving.workspace (
  id                  uuid primary key,
  account_id          uuid not null references serving.account (id),
  name                text not null check (length(btrim(name)) between 1 and 60),
  hs_code             text null check (hs_code is null or hs_code ~ '^([0-9]{2}|[0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  hs_level            text null check (hs_level is null or hs_level in ('chapter', 'heading', 'subheading', 'national8')),
  hs_version          text null,
  hs_needs_reconfirm  boolean not null default false,
  countries           text[] not null default '{}'
                        check (cardinality(countries) <= 20 and array_to_string(countries, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'),
  deleted_at          timestamptz null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((hs_code is null) = (hs_level is null) and (hs_code is null) = (hs_version is null))
);
create unique index workspace_account_name_live_uq on serving.workspace (account_id, name) where deleted_at is null;
create index workspace_account_live_idx on serving.workspace (account_id, created_at) where deleted_at is null;
create index workspace_deleted_idx on serving.workspace (deleted_at) where deleted_at is not null;
create index workspace_hs_version_idx on serving.workspace (hs_version) where hs_version is not null and deleted_at is null;
select platform.enable_tenant_rls('serving.workspace'::regclass, false);

-- LLD §0.3 rule 2: stored responses for mutating M07 endpoints replayed with an Idempotency-Key.
create table serving.tenancy_idempotency (
  account_id     uuid not null references serving.account (id),
  idem_key       text not null check (length(idem_key) between 1 and 200),
  route          text not null,
  request_hash   text not null,
  status         int not null,
  response       jsonb null,
  created_at     timestamptz not null default now(),
  primary key (account_id, idem_key)
);
create index tenancy_idempotency_created_idx on serving.tenancy_idempotency (created_at);
select platform.enable_tenant_rls('serving.tenancy_idempotency'::regclass, false);

-- migrate:down

drop table if exists serving.tenancy_idempotency;
drop table if exists serving.workspace;
drop table if exists serving.business_profile;
