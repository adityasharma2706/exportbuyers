-- M11 Review queue and admin console (core) (LLD M11).
-- REQ-064; enabling REQ-025, REQ-029, REQ-037, REQ-055.
--
-- Typed review items with an SLA timestamp, an outcome and an append-only audit trail.
-- Items are global (not tenant-scoped): they are only read and written by admin actors and
-- system jobs through systemDb(). app_serving gets its privileges from the serving-schema
-- defaults set in 0001.
--
-- Columns beyond the LLD schema (documented deviations):
--   handler_error  last outcome-handler error message, shown next to handler_result='error'
--   resolved_by    admin member who resolved the item (handlers need it as the M09 command actor)
--   resolved_at    when the item was resolved

-- migrate:up

create table serving.review_item (
  id               uuid primary key,
  type             text not null check (type ~ '^[a-z0-9][a-z0-9_.-]{0,99}$'),
  subject_refs     jsonb not null default '[]'::jsonb check (jsonb_typeof(subject_refs) = 'array'),
  payload          jsonb not null check (jsonb_typeof(payload) = 'object'),
  filed_by_kind    text not null check (filed_by_kind in ('user', 'system', 'public')),
  filed_by_ref     text null,
  state            text not null default 'open' check (state in ('open', 'in_review', 'resolved', 'rejected')),
  assignee         uuid null,
  sla_due_at       timestamptz not null,
  outcome          text null,
  outcome_payload  jsonb null,
  handler_result   text null check (handler_result in ('pending', 'ok', 'error')),
  handler_error    text null,
  resolved_by      uuid null,
  resolved_at      timestamptz null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  dedupe_key       text null check (dedupe_key is null or length(dedupe_key) between 1 and 400),
  constraint review_item_outcome_consistent check (
    (state in ('open', 'in_review') and outcome is null)
    or (state in ('resolved', 'rejected') and outcome is not null)
  ),
  constraint review_item_in_review_has_assignee check (state <> 'in_review' or assignee is not null)
);

-- unique(type, dedupe_key) where state in ('open','in_review')
create unique index review_item_dedupe_uq on serving.review_item (type, dedupe_key)
  where state in ('open', 'in_review') and dedupe_key is not null;
create index review_item_queue_idx on serving.review_item (state, type, sla_due_at);
create index review_item_sla_open_idx on serving.review_item (sla_due_at) where state in ('open', 'in_review');
create index review_item_handler_error_idx on serving.review_item (type) where handler_result = 'error';

create table serving.review_audit (
  id       uuid primary key,
  item_id  uuid not null references serving.review_item (id) on delete restrict,
  actor    uuid null, -- null for system / public actions
  action   text not null check (action in ('filed', 'claimed', 'released', 'resolved', 'handler_ok', 'handler_error')),
  before   jsonb null,
  after    jsonb null,
  at       timestamptz not null default now()
);
create index review_audit_item_idx on serving.review_audit (item_id, at);

-- The audit trail is append-only for the application role.
revoke update, delete on serving.review_audit from app_serving;

-- migrate:down

drop table if exists serving.review_audit;
drop table if exists serving.review_item;
