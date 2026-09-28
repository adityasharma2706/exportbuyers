-- M36 Plans, subscriptions and billing (Razorpay) (LLD M36). REQ-052, REQ-053, REQ-051, REQ-054.
--
-- serving.subscription / serving.payment / serving.invoice / serving.billing_details are
-- account-scoped and carry account_id, so they get the usual tenant RLS policy. Entitlements
-- change only from verified, idempotent webhooks (M36 rule): serving.webhook_event,
-- serving.invoice_seq (the per-financial-year invoice number counter) and
-- serving.billing_mismatch (the daily reconciliation job's findings) are written only by the
-- application's system path (systemDb()), never through a per-request account context, so they
-- are not tenant tables and carry no RLS policy — plain grants to app_serving (from M01) are
-- enough.
--
-- [deviation: serving.invoice is created before serving.payment so payment.invoice_id can carry
-- a real foreign key; the LLD lists payment before invoice, but a payment->invoice reference
-- needs invoice to exist first. serving.invoice_seq and serving.billing_mismatch are not in the
-- LLD's literal schema block; invoice_seq implements "invoice numbers come from a DB sequence,
-- one per financial year" (financial years are unbounded, so a fixed CREATE SEQUENCE per year is
-- not possible; a keyed counter table is used instead) and billing_mismatch implements "a status
-- mismatch -> file billing.mismatch" from the M36 Rules — M11 (review queue) is not a declared
-- dependency of M36, so mismatches are recorded here and logged at error level instead of being
-- filed through M11.file().]

-- migrate:up

create table serving.subscription (
  id                     uuid primary key,
  account_id             uuid not null unique references serving.account (id),
  plan                   text not null check (plan in ('free', 'starter', 'growth')),
  cycle                  text not null check (cycle in ('monthly', 'annual')),
  razorpay_sub_id        text null unique,
  status                 text not null check (status in ('created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed')),
  current_period_start   timestamptz null,
  current_period_end     timestamptz null,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index subscription_razorpay_sub_idx on serving.subscription (razorpay_sub_id) where razorpay_sub_id is not null;
create index subscription_updated_idx on serving.subscription (updated_at) where razorpay_sub_id is not null;
select platform.enable_tenant_rls('serving.subscription'::regclass, false);

-- Per-financial-year invoice number counter ('INV/FY26-27/000123'). FY = 1 Apr .. 31 Mar (India).
create table serving.invoice_seq (
  fy          text primary key check (fy ~ '^FY[0-9]{2}-[0-9]{2}$'),
  next_number bigint not null default 1 check (next_number >= 1)
);

create table serving.invoice (
  id                 uuid primary key,
  account_id         uuid not null references serving.account (id),
  number             text not null unique,
  gstin              text null check (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  place_of_supply    text not null check (place_of_supply ~ '^[0-9]{2}$'),
  taxable_paise      bigint not null check (taxable_paise >= 0),
  cgst_paise         bigint not null default 0 check (cgst_paise >= 0),
  sgst_paise         bigint not null default 0 check (sgst_paise >= 0),
  igst_paise         bigint not null default 0 check (igst_paise >= 0),
  pdf_s3_key         text null,
  issued_at          timestamptz not null default now()
);
create index invoice_account_issued_idx on serving.invoice (account_id, issued_at desc);
select platform.enable_tenant_rls('serving.invoice'::regclass, false);

create table serving.payment (
  id                  uuid primary key,
  account_id          uuid not null references serving.account (id),
  razorpay_payment_id text not null unique,
  amount_paise        bigint not null check (amount_paise >= 0),
  status              text not null check (status in ('captured', 'failed', 'refunded')),
  invoice_id          uuid null references serving.invoice (id),
  created_at          timestamptz not null default now()
);
create index payment_account_created_idx on serving.payment (account_id, created_at desc);
select platform.enable_tenant_rls('serving.payment'::regclass, false);

create table serving.webhook_event (
  razorpay_event_id text primary key,
  type              text not null,
  payload           jsonb not null,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz null
);
create index webhook_event_unprocessed_idx on serving.webhook_event (received_at) where processed_at is null;

create table serving.billing_details (
  account_id  uuid primary key references serving.account (id),
  legal_name  text not null check (length(btrim(legal_name)) between 1 and 200),
  gstin       text null check (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  state_code  text not null check (state_code ~ '^[0-9]{2}$'),
  address     text not null check (length(btrim(address)) between 1 and 500),
  updated_at  timestamptz not null default now()
);
select platform.enable_tenant_rls('serving.billing_details'::regclass, false);

-- Daily reconciliation findings (LLD M36 Rules: "a status mismatch -> file billing.mismatch").
create table serving.billing_mismatch (
  id              uuid primary key,
  account_id      uuid null references serving.account (id),
  razorpay_sub_id text not null,
  local_status    text not null,
  remote_status   text not null,
  detected_at     timestamptz not null default now(),
  resolved        boolean not null default false
);
create index billing_mismatch_unresolved_idx on serving.billing_mismatch (detected_at) where resolved = false;

-- migrate:down

drop table if exists serving.billing_mismatch;
drop table if exists serving.billing_details;
drop table if exists serving.webhook_event;
drop table if exists serving.payment;
drop table if exists serving.invoice;
drop table if exists serving.invoice_seq;
drop table if exists serving.subscription;
