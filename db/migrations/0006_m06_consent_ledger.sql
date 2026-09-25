-- M06 Consent and privacy notice ledger (LLD M06). REQ-062; enabling REQ-061.
-- Versioned privacy notices plus an append-only consent / withdrawal ledger. Every ledger row
-- records the notice version it was given against and when it happened.

-- migrate:up

create table serving.privacy_notice (
  version       text primary key check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  locale        text not null check (locale in ('en', 'hi')),
  body_md       text not null check (length(body_md) > 0),
  published_at  timestamptz not null default now(),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$')
);
create index privacy_notice_locale_published_idx on serving.privacy_notice (locale, published_at desc);

create table serving.consent_event (
  id              uuid primary key,
  account_id      uuid not null references serving.account (id),
  member_id       uuid null references serving.member (id),
  purpose         text not null check (purpose in ('core_service', 'marketing_email', 'whatsapp', 'analytics')),
  action          text not null check (action in ('grant', 'withdraw')),
  notice_version  text not null references serving.privacy_notice (version),
  channel         text not null default 'web' check (channel in ('web', 'api', 'admin', 'whatsapp', 'email')),
  ip              inet null,
  at              timestamptz not null default now()
);
create index consent_event_account_purpose_idx on serving.consent_event (account_id, purpose, at desc, id desc);
select platform.enable_tenant_rls('serving.consent_event'::regclass, false);

-- Append-only: the application role may read and insert, never rewrite history.
-- Notices are versioned, so a published notice is never edited either.
revoke update, delete, truncate on serving.consent_event from app_serving;
revoke update, delete, truncate on serving.privacy_notice from app_serving;

-- Guard against writes by any other role (including the table owner) as well.
create or replace function serving.consent_ledger_append_only()
  returns trigger
  language plpgsql
  as $fn$
begin
  if current_setting('app.consent_minimise', true) = 'on' and tg_op = 'UPDATE' and tg_table_name = 'consent_event' then
    -- The only permitted rewrite: IF-38a erase minimising personal fields (see below).
    if new.id is distinct from old.id or new.account_id is distinct from old.account_id
       or new.member_id is distinct from old.member_id
       or new.purpose is distinct from old.purpose or new.action is distinct from old.action
       or new.notice_version is distinct from old.notice_version or new.at is distinct from old.at
       or new.channel is distinct from old.channel or new.ip is not null then
      raise exception 'consent ledger minimisation may only null ip';
    end if;
    return new;
  end if;
  raise exception '% is append-only (% refused)', tg_table_name, tg_op;
end
$fn$;

create trigger consent_event_append_only
  before update or delete on serving.consent_event
  for each row execute function serving.consent_ledger_append_only();
create trigger privacy_notice_append_only
  before update or delete on serving.privacy_notice
  for each row execute function serving.consent_ledger_append_only();

-- IF-38a erase: the consent history is kept as proof of consent (member_id is an opaque uuid
-- and the member row itself becomes an `erased` marker in M05), but the IP address is personal
-- data and is removed. Runs with the owner's rights so the app role needs no UPDATE grant.
create or replace function serving.consent_minimise_account(p_account_id uuid)
  returns integer
  language plpgsql
  security definer
  set search_path = serving, pg_temp
  as $fn$
declare
  n integer;
begin
  perform set_config('app.consent_minimise', 'on', true);
  update serving.consent_event
     set ip = null
   where account_id = p_account_id
     and ip is not null;
  get diagnostics n = row_count;
  perform set_config('app.consent_minimise', 'off', true);
  return n;
end
$fn$;
revoke all on function serving.consent_minimise_account(uuid) from public;
grant execute on function serving.consent_minimise_account(uuid) to app_serving;

-- migrate:down

drop function if exists serving.consent_minimise_account(uuid);
drop trigger if exists privacy_notice_append_only on serving.privacy_notice;
drop trigger if exists consent_event_append_only on serving.consent_event;
drop table if exists serving.consent_event;
drop table if exists serving.privacy_notice;
drop function if exists serving.consent_ledger_append_only();
