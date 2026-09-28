-- M28 Credits ledger and price catalogue (LLD M28). REQ-054, REQ-034 (refund mechanics), REQ-051
-- (free allowances).
--
-- Append-only double-entry ledger in the `ledger` schema. Every ledger.entry insert belongs to a
-- txn_id whose credits sum to zero across the ('available','held','spent','system') buckets; a
-- deferred constraint trigger enforces this at commit time so a bug can never leave the ledger out
-- of balance. account_balance_acct is locked with `select ... for update` by the application to
-- serialise all writes for one account; balance_cache is the derived, cached balance it maintains
-- in the same transaction.

-- migrate:up

create table ledger.account_balance_acct (
  account_id  uuid primary key references serving.account (id)
);
select platform.enable_tenant_rls('ledger.account_balance_acct'::regclass, false);

create table ledger.entry (
  id                 uuid primary key,
  account_id         uuid not null references ledger.account_balance_acct (account_id),
  txn_id             uuid not null,
  kind               text not null check (kind in ('grant', 'topup', 'hold', 'commit', 'release', 'refund', 'expiry', 'adjustment')),
  bucket             text not null check (bucket in ('available', 'held', 'spent', 'system')),
  credits            integer not null check (credits <> 0),
  action_type        text null,
  action_ref         text null,
  catalogue_version  text null,
  -- Links a commit/release back to its hold, a refund back to its commit, and an expiry back to
  -- its grant. Self-references (a row pointing at another ledger.entry) rather than a foreign key
  -- to a separate "hold" table, because the hold/commit/grant IS a ledger.entry row (LLD M28).
  refers_to          uuid null references ledger.entry (id),
  idempotency_key    text not null check (length(idempotency_key) between 1 and 400),
  expires_at         timestamptz null,
  created_at         timestamptz not null default now(),
  -- Lets one logical operation (e.g. a hold) insert one row per bucket under the same key without
  -- colliding, while still rejecting an exact replay of the same (account, key, bucket) row.
  unique (account_id, idempotency_key, bucket)
);
create index entry_account_created_idx on ledger.entry (account_id, created_at);
create index entry_txn_idx on ledger.entry (txn_id);
create index entry_refers_to_idx on ledger.entry (refers_to) where refers_to is not null;
create index entry_open_hold_idx on ledger.entry (expires_at) where kind = 'hold' and bucket = 'held' and expires_at is not null;
create index entry_free_grant_idx on ledger.entry (expires_at) where kind = 'grant' and bucket = 'available' and idempotency_key like 'free:%';
select platform.enable_tenant_rls('ledger.entry'::regclass, false);

-- Double-entry invariant: every txn_id's credits sum to zero across all buckets. Deferred so all
-- rows of one transaction exist before the sum is checked.
create or replace function ledger.check_txn_balance() returns trigger
  language plpgsql
  as $$
declare
  total bigint;
begin
  select coalesce(sum(credits), 0) into total from ledger.entry where txn_id = new.txn_id;
  if total <> 0 then
    raise exception 'ledger.entry: txn_id % does not balance to zero (total=%)', new.txn_id, total
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger entry_txn_balance
  after insert on ledger.entry
  deferrable initially deferred
  for each row
  execute function ledger.check_txn_balance();

create table ledger.balance_cache (
  account_id  uuid primary key references ledger.account_balance_acct (account_id),
  available   integer not null default 0,
  held        integer not null default 0 check (held >= 0),
  updated_at  timestamptz not null default now()
);
select platform.enable_tenant_rls('ledger.balance_cache'::regclass, false);

create table ledger.allowance_usage (
  account_id  uuid not null references ledger.account_balance_acct (account_id),
  period      text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind        text not null check (kind in ('reveal', 'check')),
  used        integer not null default 0 check (used >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (account_id, period, kind)
);
select platform.enable_tenant_rls('ledger.allowance_usage'::regclass, false);

-- migrate:down

drop table if exists ledger.allowance_usage;
drop table if exists ledger.balance_cache;
drop trigger if exists entry_txn_balance on ledger.entry;
drop function if exists ledger.check_txn_balance();
drop table if exists ledger.entry;
drop table if exists ledger.account_balance_acct;
