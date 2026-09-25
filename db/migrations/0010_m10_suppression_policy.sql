-- M10 Global suppression list and Visibility & Policy layer (LLD M10, DS-06).
-- REQ-037, REQ-020, REQ-025, REQ-029, REQ-036, REQ-048, REQ-051.
--
-- knowledge.suppression holds normalised, hashed identifiers only (sha256("<kind>:" + normalised),
-- lower-case hex). No raw identifier is ever stored here.
--
-- Grants (documented exceptions, LLD M10 and "Deliberate exceptions" §4):
--   * app_serving may SELECT and INSERT knowledge.suppression: IF-10d suppress() runs in the
--     serving plane inside the M11 outcome transaction, and the search rule pipeline uses a
--     NOT EXISTS subquery over it. Rows are never updated or deleted by the app.
--   * app_serving may DELETE (and only DELETE) knowledge.search_doc and knowledge.profile_doc,
--     for the zero-window purge in M10's EV-04 handler. This is the only serving -> knowledge
--     write and is a deliberate exception to HLD rule 2.3.
--   * app_knowledge reads the list (ingestion checks it, IF-10c) through its default privileges.

-- migrate:up

create table knowledge.suppression (
  hash            text primary key check (hash ~ '^[0-9a-f]{64}$'),
  kind            text not null check (kind in ('domain', 'email', 'phone', 'company_id', 'registry')),
  reason          text not null check (reason in ('removal_request', 'operator', 'legal')),
  review_item_id  uuid null,
  created_at      timestamptz not null default now()
);
create index suppression_review_item_idx on knowledge.suppression (review_item_id) where review_item_id is not null;

grant select, insert on knowledge.suppression to app_serving;
grant delete on knowledge.search_doc, knowledge.profile_doc to app_serving;
-- A DELETE ... WHERE company_id = any(...) needs SELECT on the column it filters by; only the
-- key column is granted, so serving still cannot read doc contents from the base tables.
grant select (company_id) on knowledge.search_doc, knowledge.profile_doc to app_serving;
grant select, insert on knowledge.suppression to app_knowledge;

-- Sampled decision audit: 1% of decisions plus every deny on reveal / draft / export.
create table serving.policy_audit (
  id          uuid primary key,
  account_id  uuid null,
  surface     text not null check (surface in ('search', 'profile', 'reveal', 'draft', 'export', 'notify', 'alert', 'similar')),
  company_id  uuid not null,
  decision    jsonb not null check (jsonb_typeof(decision) = 'object'),
  at          timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index policy_audit_company_at_idx on serving.policy_audit (company_id, at desc);
create index policy_audit_account_at_idx on serving.policy_audit (account_id, at desc) where account_id is not null;

-- migrate:down

drop table if exists serving.policy_audit;
revoke select (company_id) on knowledge.search_doc, knowledge.profile_doc from app_serving;
revoke delete on knowledge.search_doc, knowledge.profile_doc from app_serving;
drop table if exists knowledge.suppression;
