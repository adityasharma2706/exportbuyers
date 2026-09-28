-- M39 Launch hardening (LLD M39 #5, #6). REQ-057, REQ-028, REQ-066, REQ-004, REQ-051.
--
-- analytics.v_cost_per_credit  "sum of cost_event by credit_ref, joined to ledger commits".
-- analytics.activation         "analytics.activation(account_id, saved_count, drafted bool,
--                               activated_at), fed by EV-08 and EV-09".
-- analytics.export_canary_hit  audit trail for the monthly export-canary web-search job (LLD #3).
--
-- The `analytics` schema exists (M01) but app_serving was never granted access to it (only
-- app_knowledge was, at boot) — every earlier module that needed app_serving to read analytics
-- data granted the specific tables it added (M14's `grant select on analytics.market_row,
-- analytics.fta to app_serving`). This migration does the same for its own three objects.

-- migrate:up

create table analytics.activation (
  account_id    uuid primary key,
  saved_count   integer not null default 0 check (saved_count >= 0),
  drafted       boolean not null default false,
  activated_at  timestamptz null,
  updated_at    timestamptz not null default now()
);
create index activation_activated_at_idx on analytics.activation (activated_at) where activated_at is not null;

create table analytics.export_canary_hit (
  id            uuid primary key,
  export_id     uuid not null,
  account_id    uuid not null,
  canary_email  text not null,
  urls          jsonb not null default '[]'::jsonb,
  found_at      timestamptz not null default now()
);
create index export_canary_hit_export_idx on analytics.export_canary_hit (export_id);
create index export_canary_hit_found_at_idx on analytics.export_canary_hit (found_at);

-- "sum of cost_event by credit_ref, joined to ledger commits" (LLD M39 #5). `credit_ref` on
-- platform.cost_event (M01) is matched to the ledger.entry row that actually charged the user
-- for the same action: a commit (bucket='spent') whose action_ref equals that credit_ref.
create view analytics.v_cost_per_credit as
select
  ce.credit_ref,
  ce.vendor,
  le.action_type,
  le.credits          as credits_committed,
  ce.cost_micros_inr   as vendor_cost_micros_inr,
  ce.at
from platform.cost_event ce
join ledger.entry le
  on le.action_ref = ce.credit_ref
 and le.kind = 'commit'
 and le.bucket = 'spent'
where ce.credit_ref is not null;

grant usage on schema analytics to app_serving;
grant select, insert, update on analytics.activation to app_serving;
grant select, insert on analytics.export_canary_hit to app_serving;
grant select on analytics.v_cost_per_credit to app_serving;
grant select, insert, update on analytics.activation to app_knowledge;
grant select, insert on analytics.export_canary_hit to app_knowledge;

-- migrate:down

revoke select, insert, update on analytics.activation from app_knowledge;
revoke select, insert on analytics.export_canary_hit from app_knowledge;
revoke select on analytics.v_cost_per_credit from app_serving;
revoke select, insert on analytics.export_canary_hit from app_serving;
revoke select, insert, update on analytics.activation from app_serving;
revoke usage on schema analytics from app_serving;
drop view if exists analytics.v_cost_per_credit;
drop table if exists analytics.export_canary_hit;
drop table if exists analytics.activation;
