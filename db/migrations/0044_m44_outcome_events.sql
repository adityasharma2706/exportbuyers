-- M44 Outcome events (LLD M44). REQ-050.
--
-- "EV-08 handler -> analytics.outcome_event(id, account_id, company_id, hs_heading, country,
-- from_status, to_status, at), written only for to_status in {replied, in_discussion,
-- order_won}. Nothing else is written, and there is no personal data."
--
-- The `analytics` schema exists (M01); app_serving's `usage` grant on it was already made by
-- M39, but this migration re-grants it (harmless/idempotent in Postgres) so this file is
-- self-contained the same way M39's own migration comment describes for its own objects.
--
-- [deviation: the LLD's literal column list has no explicit nullability for `hs_heading`. A
-- shortlisted company can carry more than one HS heading (`knowledge.profile_doc.doc.hs_headings`
-- is an array — HS scope is per M09 `search_doc`, keyed `(company_id, hs_heading)`, not a single
-- value per company), and a handful of companies carry zero (evidence limited to a
-- non-hs-scoped attribute, e.g. only a `buyer_type`/`registry.match` assertion so far). The
-- event carries a single `hs_heading` column per LLD's literal schema, so this handler (M44
-- events.ts) writes one row per `(company_id, hs_heading)` pair the company's profile doc
-- currently carries, and `hs_heading` is nullable here to allow the zero-heading case rather
-- than silently dropping the outcome altogether.]

-- migrate:up

create table analytics.outcome_event (
  id            uuid primary key,
  account_id    uuid not null,
  company_id    uuid not null,
  hs_heading    text null,
  country       text not null,
  from_status   text null check (from_status is null or from_status in
                  ('to_contact', 'contacted', 'replied', 'in_discussion', 'sample_sent', 'order_won', 'not_interested')),
  to_status     text not null check (to_status in ('replied', 'in_discussion', 'order_won')),
  at            timestamptz not null
);
create index outcome_event_account_idx on analytics.outcome_event (account_id, at desc);
create index outcome_event_heading_status_idx on analytics.outcome_event (hs_heading, to_status);
create index outcome_event_country_idx on analytics.outcome_event (country, hs_heading);

grant usage on schema analytics to app_serving;
grant select, insert on analytics.outcome_event to app_serving;

-- migrate:down

revoke select, insert on analytics.outcome_event from app_serving;
drop table if exists analytics.outcome_event;
