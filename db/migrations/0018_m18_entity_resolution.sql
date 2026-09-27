-- M18 Normalisation and entity resolution (LLD M18). Enabling REQ-021 and REQ-037; REQ-064.
--
-- knowledge.company_match_key   the fuzzy-matching key per canonical company: the M17-normalised
--                               name, the normalised city and the distinctive address tokens. The
--                               pg_trgm GIN index on name_norm is the candidate prefilter
--                               (similarity > 0.5 within a country). Written only by M18 resolve().
--
-- Anchors (lei / registry / vat / domain) and merge decisions stay in M09's company_anchor and
-- merge_decision tables. pg_trgm is installed by M01 (0001).

-- migrate:up

create table knowledge.company_match_key (
  company_id      uuid        primary key references knowledge.company (id),
  country         text        not null check (country ~ '^[A-Z]{2}$'),
  name_norm       text        not null check (length(name_norm) between 1 and 500),
  city_norm       text        null check (city_norm is null or length(city_norm) between 1 and 200),
  address_tokens  text[]      not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index company_match_key_country_idx on knowledge.company_match_key (country);
create index company_match_key_name_trgm_idx on knowledge.company_match_key using gin (name_norm gin_trgm_ops);

-- Owned by the knowledge plane (app_knowledge) through M01's default privileges; the serving plane
-- never reads it.

-- migrate:down

drop table if exists knowledge.company_match_key;
