-- M09 Evidence store: assertions, canonical companies and read-model projections (LLD M09,
-- DS-04 / DS-05). REQ-017, REQ-024, REQ-033; enabling REQ-021, REQ-032.
--
-- Written by the knowledge plane (app_knowledge) through kp.m09_evidence only.
-- app_serving reads the three read-model views (v_search_doc, v_profile_doc,
-- v_company_redirect) and nothing else in this migration. Contact values are readable only
-- through v_contact_value, granted to app_reveal (M29's repository).

-- migrate:up

create table knowledge.company (
  id              uuid primary key,
  status          text not null default 'active' check (status in ('active', 'merged', 'closed')),
  merged_into     uuid null references knowledge.company (id),
  display_name    text not null check (length(display_name) between 1 and 500),
  country         text not null check (country ~ '^[A-Z]{2}$'),
  city            text null,
  primary_domain  text null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint company_merge_consistent check ((status = 'merged') = (merged_into is not null)),
  constraint company_not_merged_into_self check (merged_into is null or merged_into <> id)
);
create index company_merged_into_idx on knowledge.company (merged_into) where merged_into is not null;
create index company_country_idx on knowledge.company (country);

create table knowledge.company_anchor (
  kind        text not null check (kind in ('registry', 'lei', 'vat', 'domain')),
  value_norm  text not null check (length(value_norm) between 1 and 500),
  company_id  uuid not null references knowledge.company (id),
  primary key (kind, value_norm)
);
create index company_anchor_company_idx on knowledge.company_anchor (company_id);

create table knowledge.assertion (
  id                   uuid primary key,
  subject_type         text not null check (subject_type in ('company', 'person')),
  subject_id           uuid not null,
  attribute            text not null,
  value                jsonb not null check (jsonb_typeof(value) = 'object'),
  polarity             text not null check (polarity in ('positive', 'negative')),
  source_id            text not null references knowledge.source (id),
  source_type          text not null,
  source_ref           jsonb not null check (jsonb_typeof(source_ref) = 'object'),
  observed_at          timestamptz not null,
  checked_at           timestamptz not null,
  confidence           real not null check (confidence between 0 and 1),
  can_display          boolean not null,
  can_export           boolean not null,
  personal_data_class  text not null check (personal_data_class in ('none', 'business_contact', 'named_person')),
  region               text null,
  producer             text not null,
  producer_version     text not null,
  llm_assisted         boolean not null default false,
  superseded_by        uuid null references knowledge.assertion (id),
  hs_heading           text null check (hs_heading is null or hs_heading ~ '^[0-9]{4}$'),
  created_at           timestamptz not null default now(),
  -- Nothing can be exported that could not be shown.
  constraint assertion_export_implies_display check (not can_export or can_display),
  -- DS-04: an LLM-derived fact must point at the captured page.
  constraint assertion_llm_page_ref check (
    not llm_assisted or (coalesce(source_ref ->> 'url', '') <> '' and coalesce(source_ref ->> 'captured_at', '') <> '')
  ),
  -- REQ-035 is not built: person subjects are modelled but disabled.
  constraint assertion_no_person_subjects check (subject_type = 'company')
);
create index assertion_active_subject_attr_idx on knowledge.assertion (subject_id, attribute) where superseded_by is null;
create index assertion_attr_checked_idx on knowledge.assertion (attribute, checked_at);
create index assertion_heading_subject_idx on knowledge.assertion (hs_heading, subject_id);
create index assertion_superseded_by_idx on knowledge.assertion (superseded_by) where superseded_by is not null;

create table knowledge.search_doc (
  company_id          uuid not null references knowledge.company (id) on delete cascade,
  hs_heading          text not null check (hs_heading ~ '^[0-9]{4}$'),
  doc                 jsonb not null,
  tsv                 tsvector not null,
  country             text not null,
  buyer_type          text null,
  trust_level         text not null default 'unknown',
  last_activity       date null,
  shipment_freq       integer null,
  volume_score        real null,
  origin_india        text not null default 'unknown' check (origin_india in ('yes', 'no', 'unknown')),
  origin_competitor   text not null default 'unknown' check (origin_competitor in ('yes', 'no', 'unknown')),
  contact_types       text[] not null default '{}',
  is_logistics        boolean not null default false,
  sanctions_block     boolean not null default false,
  identifier_hashes   text[] not null default '{}',
  projection_version  integer not null,
  built_at            timestamptz not null,
  primary key (company_id, hs_heading)
);
create index search_doc_tsv_gin on knowledge.search_doc using gin (tsv);
create index search_doc_identifier_hashes_gin on knowledge.search_doc using gin (identifier_hashes);
create index search_doc_contact_types_gin on knowledge.search_doc using gin (contact_types);
create index search_doc_country_heading_idx on knowledge.search_doc (country, hs_heading);

create table knowledge.profile_doc (
  company_id          uuid primary key references knowledge.company (id) on delete cascade,
  doc                 jsonb not null,
  identifier_hashes   text[] not null default '{}',
  sanctions_block     boolean not null default false,
  is_logistics        boolean not null default false,
  projection_version  integer not null,
  built_at            timestamptz not null
);
create index profile_doc_identifier_hashes_gin on knowledge.profile_doc using gin (identifier_hashes);

create table knowledge.contact_value (
  assertion_id  uuid primary key references knowledge.assertion (id),
  company_id    uuid not null references knowledge.company (id),
  kind          text not null check (kind in ('website', 'phone', 'role_email', 'form_url', 'address', 'whatsapp')),
  value         text not null check (length(value) between 1 and 2048),
  value_hash    text not null check (value_hash ~ '^[0-9a-f]{64}$')
);
create index contact_value_hash_idx on knowledge.contact_value (value_hash);
create index contact_value_company_idx on knowledge.contact_value (company_id);

-- IF-09b merge outcomes, so resolution (M18) does not re-file pairs already decided.
create table knowledge.merge_decision (
  a               uuid not null references knowledge.company (id),
  b               uuid not null references knowledge.company (id),
  decision        text not null check (decision in ('merge', 'distinct')),
  review_item_id  uuid null,
  actor           text not null,
  decided_at      timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);

-- Merge follow-through (HLD OQ3): serving tables keep old ids and resolve them here.
create or replace view knowledge.company_redirect as
with recursive chain (id, current_id, hops) as (
  select c.id, c.id, 0 from knowledge.company c where c.merged_into is null
  union all
  select m.id, chain.current_id, chain.hops + 1
    from knowledge.company m
    join chain on m.merged_into = chain.id
   where chain.hops < 10
)
select id, current_id from chain;

create or replace view knowledge.v_company_redirect as
  select id, current_id from knowledge.company_redirect;

create or replace view knowledge.v_search_doc as
  select company_id, hs_heading, doc, tsv, country, buyer_type, trust_level, last_activity, shipment_freq,
         volume_score, origin_india, origin_competitor, contact_types, is_logistics, sanctions_block,
         identifier_hashes, projection_version, built_at
    from knowledge.search_doc;

create or replace view knowledge.v_profile_doc as
  select company_id, doc, identifier_hashes, sanctions_block, is_logistics, projection_version, built_at
    from knowledge.profile_doc;

create or replace view knowledge.v_contact_value as
  select assertion_id, company_id, kind, value, value_hash from knowledge.contact_value;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_reveal') then
    create role app_reveal nologin;
  end if;
end
$roles$;

-- Serving reads the read-model views only; none of the base tables.
revoke all on knowledge.company, knowledge.company_anchor, knowledge.assertion, knowledge.search_doc,
  knowledge.profile_doc, knowledge.contact_value, knowledge.merge_decision, knowledge.company_redirect,
  knowledge.v_contact_value from app_serving;
grant select on knowledge.v_search_doc, knowledge.v_profile_doc, knowledge.v_company_redirect to app_serving;

grant usage on schema knowledge to app_reveal;
grant select on knowledge.v_contact_value to app_reveal;
-- The knowledge plane (app_knowledge) owns these tables through M01's default privileges.

-- migrate:down

drop view if exists knowledge.v_contact_value;
drop view if exists knowledge.v_profile_doc;
drop view if exists knowledge.v_search_doc;
drop view if exists knowledge.v_company_redirect;
drop view if exists knowledge.company_redirect;
drop table if exists knowledge.merge_decision;
drop table if exists knowledge.contact_value;
drop table if exists knowledge.profile_doc;
drop table if exists knowledge.search_doc;
drop table if exists knowledge.assertion;
drop table if exists knowledge.company_anchor;
drop table if exists knowledge.company;
