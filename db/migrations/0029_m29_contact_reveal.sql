-- M29 Contact reveal (LLD M29). REQ-032, REQ-033, REQ-034, REQ-029 (blocked reveal), REQ-054.
--
-- serving.reveal / serving.reveal_contact hold the *result* of a reveal: which contacts an
-- account has paid to unlock for a company, and their encrypted values (encrypted with a data
-- key at rest, decrypted only by M29's own repo). serving.reveal_bulk tracks a bulk-reveal
-- request that ran (or is running) as a background job so the UI can poll it.
--
-- [deviation: the LLD's literal schema for serving.reveal_contact has no account_id column
-- (its primary key is (reveal_id, assertion_id)). An account_id column is added here so M01's
-- tenant RLS (platform.enable_tenant_rls) protects encrypted contact values at the database
-- layer too, not only via the application always resolving reveal_id through an account-scoped
-- serving.reveal lookup first. The primary key is unchanged.]

-- migrate:up

create table serving.reveal (
  id                 uuid primary key,
  account_id         uuid not null references serving.account (id),
  company_id         uuid not null,
  state              text not null check (state in ('pending', 'done', 'failed')),
  hold_id            uuid null,
  commit_entry_id    uuid null,
  catalogue_version  text null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index reveal_account_company_done_uidx on serving.reveal (account_id, company_id) where state = 'done';
create index reveal_account_created_idx on serving.reveal (account_id, created_at);
select platform.enable_tenant_rls('serving.reveal'::regclass, false);

create table serving.reveal_contact (
  reveal_id      uuid not null references serving.reveal (id),
  account_id     uuid not null references serving.account (id),
  assertion_id   uuid not null,
  kind           text not null check (kind in ('website', 'phone', 'role_email', 'form_url', 'address', 'whatsapp')),
  value_enc      bytea not null,
  deliverability text not null check (deliverability in ('valid', 'risky', 'invalid', 'unknown')),
  checked_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  primary key (reveal_id, assertion_id)
);
create index reveal_contact_account_idx on serving.reveal_contact (account_id);
select platform.enable_tenant_rls('serving.reveal_contact'::regclass, false);

-- Tracks one POST /api/reveal/bulk request that is too large to finish inline (LLD M29 Bulk:
-- "If the batch is large, the request is processed as a job and the UI polls
-- GET /api/reveal/bulk/:id"). `id` is also the m02 job's idempotency key.
create table serving.reveal_bulk (
  id                 uuid primary key,
  account_id         uuid not null references serving.account (id),
  state              text not null check (state in ('queued', 'running', 'done', 'failed')),
  company_ids        uuid[] not null,
  confirmed_credits  integer not null check (confirmed_credits >= 0),
  results            jsonb not null default '[]'::jsonb,
  credits_charged    integer not null default 0,
  error              text null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index reveal_bulk_account_created_idx on serving.reveal_bulk (account_id, created_at);
select platform.enable_tenant_rls('serving.reveal_bulk'::regclass, false);

-- migrate:down

drop table if exists serving.reveal_bulk;
drop table if exists serving.reveal_contact;
drop table if exists serving.reveal;
