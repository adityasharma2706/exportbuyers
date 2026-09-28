-- M30 Reports and automatic invalid-contact refunds (LLD M30).
-- REQ-025 (per-user hide), REQ-034 (automatic refund of a paid-for invalid contact), REQ-064
-- (content reports go through the M11 review queue).
--
-- serving.user_hide is IF-30b's backing store: M30 registers itself as M10's `userHides`
-- provider (IF-10b) and reads straight from this table. A hide takes effect on the very next
-- read because M10's policy decisions are computed per request, not cached per company.
--
-- serving.report is the LLD's `serving.report` schema, plus columns documented below (the same
-- kind of deviation M11's own migration takes for its extra bookkeeping columns):
--   review_item_id   the M11 review_item this report is linked to: the *content-report* item for
--                     wrong_product/not_buyer/closed/suspicious (many report rows can point at the
--                     same item, since M11 dedupes by (company, reason)), or the
--                     `report.refund_exception` item when an unconfirmed refund is over the
--                     monthly cap.
--   refund_kind       'confirmed' (M25 wrote ContactInvalidated: the contact really is dead) or
--                     'unconfirmed' (ContactVerified / a 24h timeout: refunded on trust, subject
--                     to the monthly cap). Null until a refund (or refund exception) is decided.
--   refund_period     the IST 'YYYY-MM' period an 'unconfirmed' refund was charged against in
--                     serving.report_refund_usage (LLD "capped per user per month").
--   refund_credits    credits actually refunded (or proposed, for a filed exception).
--   refund_entry_id   ledger.entry id of the refund (IF-28a RefundResult.refundEntryId), once paid.
--
-- serving.report_refund_usage is M30's own counter for the monthly unconfirmed-refund cap
-- (mirrors ledger.allowance_usage's (account, period) shape, LLD M28 schema), so the cap check is
-- a single row lock rather than a scan of serving.report.

-- migrate:up

create table serving.user_hide (
  account_id   uuid not null references serving.account (id),
  target_kind  text not null check (target_kind in ('company', 'assertion')),
  target_id    uuid not null,
  created_at   timestamptz not null default now(),
  primary key (account_id, target_kind, target_id)
);
select platform.enable_tenant_rls('serving.user_hide'::regclass, false);

create table serving.report (
  id              uuid primary key,
  account_id      uuid not null references serving.account (id),
  company_id      uuid not null,
  assertion_id    uuid null,
  reason          text not null check (reason in ('wrong_product', 'not_buyer', 'closed', 'invalid_contact', 'suspicious')),
  note            text null check (note is null or length(note) <= 1000),
  reveal_id       uuid null,
  state           text not null default 'open' check (state in ('open', 'reverifying', 'refunded', 'review', 'closed')),
  review_item_id  uuid null,
  refund_kind     text null check (refund_kind in ('confirmed', 'unconfirmed')),
  refund_period   text null check (refund_period is null or refund_period ~ '^[0-9]{4}-[0-9]{2}$'),
  refund_credits  integer null check (refund_credits is null or refund_credits >= 0),
  refund_entry_id uuid null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index report_account_created_idx on serving.report (account_id, created_at desc);
-- EV-06 correlation: which reverifying reports (any account) are waiting on this assertion.
create index report_assertion_reverifying_idx on serving.report (assertion_id) where state = 'reverifying';
create index report_review_item_idx on serving.report (review_item_id) where review_item_id is not null;
select platform.enable_tenant_rls('serving.report'::regclass, false);

create table serving.report_refund_usage (
  account_id  uuid not null references serving.account (id),
  period      text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  used        integer not null default 0 check (used >= 0),
  updated_at  timestamptz not null default now(),
  primary key (account_id, period)
);
select platform.enable_tenant_rls('serving.report_refund_usage'::regclass, false);

-- migrate:down

drop table if exists serving.report_refund_usage;
drop table if exists serving.report;
drop table if exists serving.user_hide;
