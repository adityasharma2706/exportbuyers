-- M12 HS nomenclature store (LLD M12). Data for REQ-005, REQ-006, REQ-007 and REQ-009.
--
-- knowledge.hs_code         every code, versioned by nomenclature ('HS2022', 'HS2027', 'ITCHS2022', ...)
-- knowledge.hs_correlation  WCO correlation tables between nomenclature versions
-- knowledge.hs_version      which versions are loaded and which is current, per family
--
-- Families: a version is '<family><yyyy>' where family is 'HS' (WCO, 2/4/6 digits) or 'ITCHS'
-- (DGFT national 8-digit lines). Exactly one version per family may be current. ITC-HS rows are
-- national8 only; their 6-digit parents live in the corresponding HS version ('ITCHS2022' →
-- 'HS2022'). Loaders (py/kp/m12_hs) enforce that no 8-digit code is orphaned.
--
-- Written only by the knowledge plane loaders (app_knowledge); read by the serving plane.

-- migrate:up

create table knowledge.hs_version (
  version    text primary key check (version ~ '^(HS|ITCHS)[0-9]{4}$'),
  loaded_at  timestamptz not null default now(),
  is_current boolean not null default false
);
-- One current version per family.
create unique index hs_version_current_family_uidx
  on knowledge.hs_version ((regexp_replace(version, '[0-9]{4}$', '')))
  where is_current;

create table knowledge.hs_code (
  version               text not null references knowledge.hs_version (version) on delete cascade,
  code                  text not null check (code ~ '^([0-9]{2}|[0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  level                 text not null check (level in ('chapter', 'heading', 'subheading', 'national8')),
  parent_code           text null check (parent_code is null or parent_code ~ '^([0-9]{2}|[0-9]{4}|[0-9]{6})$'),
  description           text not null check (length(description) between 1 and 4000),
  description_en_simple text null check (description_en_simple is null or length(description_en_simple) <= 1000),
  export_policy         text null check (export_policy in ('free', 'restricted', 'prohibited', 'ste')),
  policy_conditions     text null,
  policy_source_url     text null check (policy_source_url is null or policy_source_url ~ '^https?://'),
  embedding             vector(1024) null,
  primary key (version, code),
  -- The level follows from the number of digits.
  constraint hs_code_level_matches_length check (
    (level = 'chapter' and length(code) = 2) or
    (level = 'heading' and length(code) = 4) or
    (level = 'subheading' and length(code) = 6) or
    (level = 'national8' and length(code) = 8)
  ),
  -- A child code starts with its parent's digits; only chapters have no parent.
  constraint hs_code_parent_prefix check (
    (level = 'chapter' and parent_code is null) or
    (level <> 'chapter' and parent_code is not null and left(code, length(parent_code)) = parent_code
       and length(parent_code) < length(code))
  ),
  -- Export policy is a national (ITC-HS) attribute.
  constraint hs_code_policy_national_only check (
    level = 'national8' or (export_policy is null and policy_conditions is null and policy_source_url is null)
  )
);
create index hs_code_parent_idx on knowledge.hs_code (version, parent_code);
create index hs_code_level_idx on knowledge.hs_code (version, level);
create index hs_code_description_trgm_idx on knowledge.hs_code using gin (description gin_trgm_ops);
-- Cosine ANN for vectorSearch (IF-12a).
create index hs_code_embedding_hnsw_idx on knowledge.hs_code using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

create table knowledge.hs_correlation (
  from_version text not null references knowledge.hs_version (version) on delete cascade,
  from_code    text not null check (from_code ~ '^([0-9]{2}|[0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  to_version   text not null references knowledge.hs_version (version) on delete cascade,
  to_code      text not null check (to_code ~ '^([0-9]{2}|[0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  relation     text not null check (relation in ('1:1', '1:n', 'n:1', 'n:n')),
  check (from_version <> to_version),
  primary key (from_version, from_code, to_version, to_code)
);
create index hs_correlation_reverse_idx on knowledge.hs_correlation (to_version, to_code, from_version);

-- Serving (M13 helper, M40 re-confirmation, M14 analytics) reads; only the knowledge plane writes.
grant select on knowledge.hs_version, knowledge.hs_code, knowledge.hs_correlation to app_serving;

-- WCO nomenclature source for WcoHsLoader / CorrelationLoader. The register is changed by
-- migration; this row must also be added to config/sources.yaml (see the M12 progress note).
insert into knowledge.source
  (id, source_type, can_store, can_display, can_export, retention_days, attribution_text,
   personal_data_class, allowed_regions, status, notes)
values
  ('nomenclature.wco.hs', 'nomenclature', true, true, true, null, 'Source: Harmonized System nomenclature and correlation tables, World Customs Organization', 'none', array['*'], 'active', 'WCO HS 2022 / HS 2027 nomenclature and correlation tables used for HS code pickers and version changes.')
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

drop table if exists knowledge.hs_correlation;
drop table if exists knowledge.hs_code;
drop table if exists knowledge.hs_version;
delete from knowledge.source where id = 'nomenclature.wco.hs';
