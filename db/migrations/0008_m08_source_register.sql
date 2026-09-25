-- M08 Source licence register and connector framework (LLD M08, DS-02).
-- REQ-036; enabling REQ-033 (source attribution) and REQ-048 (export rights).
--
-- knowledge.source is the licence register. It is seeded from /config/sources.yaml; every change
-- to that file ships with a migration that upserts the changed rows. The seed rows below mirror
-- the YAML exactly (one row per line) and kp/m08_sources/test_m08_sources.py checks they agree.
--
-- knowledge.raw_object records every raw payload landed to the immutable raw bucket
-- (s3://<raw bucket>/<source_id>/<yyyy>/<mm>/<dd>/<sha256>). Landing is idempotent on
-- (source_id, sha256).

-- migrate:up

create table knowledge.source (
  id                   text primary key check (id ~ '^[a-z0-9][a-z0-9_.-]{0,99}$'),
  source_type          text not null check (source_type in
                         ('customs', 'website', 'directory', 'registry', 'sanctions', 'market_stats',
                          'nomenclature', 'user_report', 'operator')),
  can_store            boolean not null,
  can_display          boolean not null,
  can_export           boolean not null,
  retention_days       integer null check (retention_days is null or retention_days between 1 and 36500),
  attribution_text     text not null check (length(attribution_text) between 1 and 500),
  personal_data_class  text not null check (personal_data_class in ('none', 'business_contact', 'named_person')),
  allowed_regions      text[] not null default '{}'
                         check (array_position(allowed_regions, null) is null),
  status               text not null check (status in ('active', 'disabled', 'prohibited')),
  notes                text null,
  updated_at           timestamptz not null default now(),
  -- A prohibited source carries no rights at all.
  constraint source_prohibited_has_no_rights check (
    status <> 'prohibited' or (not can_store and not can_display and not can_export)
  ),
  -- Export implies display: nothing can be exported that could not be shown.
  constraint source_export_implies_display check (not can_export or can_display)
);
create index source_status_idx on knowledge.source (status);

create or replace function knowledge.source_touch_updated_at()
  returns trigger
  language plpgsql
  as $fn$
begin
  new.updated_at := now();
  return new;
end
$fn$;

create trigger source_touch_updated_at
  before update on knowledge.source
  for each row execute function knowledge.source_touch_updated_at();

create table knowledge.raw_object (
  id          uuid primary key,
  source_id   text not null references knowledge.source (id),
  s3_key      text not null unique,
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  fetched_at  timestamptz not null default now(),
  url         text null,
  bytes       bigint not null check (bytes >= 0),
  expires_at  timestamptz null
);
-- Idempotency of land(): the same bytes from the same source are stored once.
create unique index raw_object_source_sha_uidx on knowledge.raw_object (source_id, sha256);
create index raw_object_expires_idx on knowledge.raw_object (expires_at) where expires_at is not null;

-- The register is changed by migration only; the knowledge-plane role reads it and never edits it.
revoke insert, update, delete, truncate on knowledge.source from app_knowledge;
-- Raw-object rows are immutable except for removal once expired (M08 nightly job) or erased (M38).
revoke update, truncate on knowledge.raw_object from app_knowledge;
-- Serving (M10 display, M35 export) reads licence flags and attribution.
grant select on knowledge.source to app_serving;

insert into knowledge.source
  (id, source_type, can_store, can_display, can_export, retention_days, attribution_text,
   personal_data_class, allowed_regions, status, notes)
values
  ('web.crawl', 'website', true, true, true, 365, 'Source: the company''s own public website', 'business_contact', array['*'], 'active', 'Robots-respecting crawl of company websites. Only business contact details are kept.'),
  ('registry.gb.ch', 'registry', true, true, true, null, 'Contains public sector information from Companies House licensed under the Open Government Licence v3.0', 'named_person', array['GB'], 'active', 'Companies House public data product (OGL v3.0). Officer names are named-person data.'),
  ('registry.gleif', 'registry', true, true, true, null, 'Legal Entity Identifier data from GLEIF, available under CC0', 'none', array['*'], 'active', 'GLEIF golden copy (CC0).'),
  ('sanctions.un.sc', 'sanctions', true, true, false, 730, 'Source: United Nations Security Council Consolidated List', 'named_person', array['*'], 'active', 'Used for screening; listed entities are shown as blocked, not exported.'),
  ('sanctions.us.ofac', 'sanctions', true, true, false, 730, 'Source: U.S. Treasury OFAC Specially Designated Nationals List', 'named_person', array['*'], 'active', 'SDN and consolidated non-SDN lists.'),
  ('sanctions.eu.fsf', 'sanctions', true, true, false, 730, 'Source: EU Financial Sanctions Files (consolidated list)', 'named_person', array['*'], 'active', 'EU consolidated financial sanctions list.'),
  ('sanctions.gb.ofsi', 'sanctions', true, true, false, 730, 'Contains public sector information from HM Treasury (OFSI) licensed under the Open Government Licence v3.0', 'named_person', array['*'], 'active', 'UK consolidated list of financial sanctions targets.'),
  ('nomenclature.in.itchs', 'nomenclature', true, true, true, null, 'Source: ITC(HS) classification, Directorate General of Foreign Trade, Government of India', 'none', array['*'], 'active', 'Indian tariff nomenclature used for HS code pickers.'),
  ('market_stats.un.comtrade', 'market_stats', true, true, false, null, 'Source: UN Comtrade Database, United Nations', 'none', array['*'], 'active', 'Aggregate trade statistics. Display with attribution; bulk redistribution is not permitted, so no export.'),
  ('user_report', 'user_report', true, false, false, 730, 'Reported by a user', 'business_contact', array['*'], 'active', 'User corrections and reports. Not shown or exported until an operator confirms them (operator.manual).'),
  ('operator.manual', 'operator', true, true, true, null, 'Verified by our research team', 'business_contact', array['*'], 'active', 'Operator-entered or operator-confirmed facts.'),
  ('linkedin', 'directory', false, false, false, null, 'LinkedIn', 'named_person', array[]::text[], 'prohibited', 'LinkedIn User Agreement prohibits scraping and automated collection. Never connect.'),
  ('social.meta', 'directory', false, false, false, null, 'Meta (Facebook, Instagram)', 'named_person', array[]::text[], 'prohibited', 'Meta terms prohibit automated data collection without prior permission.'),
  ('social.x', 'directory', false, false, false, null, 'X (Twitter)', 'named_person', array[]::text[], 'prohibited', 'X terms prohibit crawling or scraping without prior written consent.')
on conflict (id) do update set
  source_type = excluded.source_type,
  can_store = excluded.can_store,
  can_display = excluded.can_display,
  can_export = excluded.can_export,
  retention_days = excluded.retention_days,
  attribution_text = excluded.attribution_text,
  personal_data_class = excluded.personal_data_class,
  allowed_regions = excluded.allowed_regions,
  status = excluded.status,
  notes = excluded.notes;

-- migrate:down

drop table if exists knowledge.raw_object;
drop trigger if exists source_touch_updated_at on knowledge.source;
drop table if exists knowledge.source;
drop function if exists knowledge.source_touch_updated_at();
