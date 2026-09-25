-- M05 Identity and sessions (LLD M05). REQ-001, REQ-004.
-- Passwordless OTP (SMS via DLT provider, email via ESP), sessions (anonymous and signed in),
-- role model and admin MFA.

-- migrate:up

create table serving.account (
  id          uuid primary key,
  status      text not null default 'active' check (status in ('active', 'deleting', 'deleted')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table serving.member (
  id               uuid primary key,
  account_id       uuid not null references serving.account (id),
  phone_e164       text unique null check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email            citext unique null,
  role             text not null default 'owner' check (role in ('owner', 'member', 'consultant')),
  is_admin         boolean not null default false,
  admin_role       text null check (admin_role is null or admin_role in ('admin_support', 'admin_ops', 'admin_super')),
  totp_secret_enc  bytea null,
  -- Set by the IF-38a erase path once the account is closed; it is the only state in which a
  -- member may carry neither a phone number nor an email address.
  erased_at        timestamptz null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (phone_e164 is not null or email is not null or erased_at is not null),
  check (not is_admin or admin_role is not null)
);
create index member_account_idx on serving.member (account_id);
select platform.enable_tenant_rls('serving.member'::regclass, false);

-- Pre-authentication table: read and written only through systemDb() by M05.
create table serving.otp_challenge (
  id                uuid primary key,
  channel           text not null check (channel in ('sms', 'email')),
  destination_hash  text not null,
  code_hash         text not null,
  attempts          int not null default 0 check (attempts >= 0),
  expires_at        timestamptz not null,
  consumed_at       timestamptz null,
  ip                inet null,
  created_at        timestamptz not null default now()
);
create index otp_challenge_dest_idx on serving.otp_challenge (destination_hash, created_at desc);
create index otp_challenge_expires_idx on serving.otp_challenge (expires_at);

-- id is sha256(hex) of the 256-bit random token held in the `sid` cookie; the raw token is
-- never stored.
create table serving.session (
  id                  text primary key,
  member_id           uuid null references serving.member (id) on delete cascade,
  anon                boolean not null,
  anon_state          jsonb not null default '{}'::jsonb,
  -- Anonymous work ({hsCode, hsVersion, countries[]}) carried over at sign-in; consumed by M07.
  anon_state_pending  jsonb null,
  mfa_verified        boolean not null default false,
  ip                  inet null,
  ua_hash             text null,
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  check (anon = (member_id is null))
);
create index session_member_idx on serving.session (member_id) where member_id is not null;
create index session_expires_idx on serving.session (expires_at);

-- migrate:down

drop table if exists serving.session;
drop table if exists serving.otp_challenge;
drop table if exists serving.member;
drop table if exists serving.account;
