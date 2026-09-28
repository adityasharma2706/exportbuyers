-- M32 Check a buyer (LLD M32). REQ-030, REQ-031 (contextual part), REQ-051 (limited free use).
--
-- serving.check_run holds the history of a signed-in account's ad hoc buyer checks: the free-text
-- input it was run on (encrypted — it is a visitor's own free text about a third party) and the
-- computed result (trust rollup, sanctions, red flags, advice keys, matched company). LLD M32:
-- "The input is stored in serving.check_run(id, account_id, input_enc, result jsonb, created_at)
-- for the user's history. Nothing is written to knowledge." Anonymous checks are never persisted
-- here (there is no account row to attach them to); only M05's `guardAnonymous('check')` limits
-- those.

-- migrate:up

create table serving.check_run (
  id          uuid primary key,
  account_id  uuid not null references serving.account (id),
  input_enc   bytea not null,
  result      jsonb not null,
  created_at  timestamptz not null default now()
);
create index check_run_account_created_idx on serving.check_run (account_id, created_at desc);
select platform.enable_tenant_rls('serving.check_run'::regclass, false);

-- migrate:down

drop table if exists serving.check_run;
