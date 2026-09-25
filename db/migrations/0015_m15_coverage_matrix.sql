-- M15 Coverage matrix builder (LLD M15). Data side of REQ-012.
--
-- knowledge.coverage_cell  one row per country × HS heading, plus one country-level fallback row per
--                          country (hs_heading = '*') aggregating across headings. Computed by the
--                          knowledge plane (py/kp/m15_coverage) from the evidence store (M09) under
--                          RULE_V=1; read by the serving plane through IF-15a coverage().
--
-- A heading row exists only while at least one company has evidence for it; when none is left the
-- row is deleted so reads fall back to the country row, and then to a synthetic 'limited' cell.

-- migrate:up

create table knowledge.coverage_cell (
  country              text        not null check (country ~ '^[A-Z]{2}$'),
  hs_heading           text        not null check (hs_heading = '*' or hs_heading ~ '^[0-9]{4}$'),
  source_types         text[]      not null default '{}',
  company_count        integer     not null check (company_count >= 0),
  fresh_company_count  integer     not null check (fresh_company_count >= 0),
  label                text        not null check (label in ('strong', 'partial', 'limited')),
  explanation_key      text        not null check (explanation_key ~ '^coverage\.[a-z_.]+$'),
  params               jsonb       not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  rule_version         integer     not null check (rule_version >= 1),
  computed_at          timestamptz not null default now(),
  primary key (country, hs_heading),
  constraint coverage_cell_fresh_le_total check (fresh_company_count <= company_count)
);

-- Supports the freshness computation: evidence rows by heading within a recency window.
create index if not exists assertion_heading_checked_idx
  on knowledge.assertion (hs_heading, checked_at)
  where superseded_by is null and hs_heading is not null;

-- Serving plane: IF-15a reads the matrix (no tenant scope; reference data).
grant select on knowledge.coverage_cell to app_serving;

-- migrate:down

revoke select on knowledge.coverage_cell from app_serving;
drop index if exists knowledge.assertion_heading_checked_idx;
drop table if exists knowledge.coverage_cell;
