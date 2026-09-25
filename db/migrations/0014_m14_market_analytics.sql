-- M14 Market analytics builder (LLD M14). Data for REQ-010, REQ-011 and REQ-013.
--
-- analytics.trade_flow  UN Comtrade importer-reported flows: reporter × partner × HS6 × year.
--                       reporter / partner are ISO 3166-1 alpha-2; partner 'WLD' is the reporter's
--                       reported world total; partners Comtrade reports as areas/aggregates that
--                       have no ISO code are kept as 'M49:<code>' (they count towards the partner
--                       sum but are never shown as a supplier).
-- analytics.market_row  one row per importing country × HS6 (and per country × HS4 aggregate,
--                       keyed hs6 = '<4 digits>__'), with the SCORE_V=1 score and its rank within
--                       that code. why_input_hash is the sha256 of the numbers the row currently
--                       carries; why_text is only ever the summary generated from exactly those
--                       numbers (null = not generated yet, or the number post-check failed).
-- analytics.fta         curated FTA / CEPA table (India ↔ partner), maintained by operators.
--
-- Written only by the knowledge plane (app_knowledge); the serving plane reads market_row / fta.

-- migrate:up

create table analytics.trade_flow (
  reporter    text    not null check (reporter ~ '^[A-Z]{2}$'),
  partner     text    not null check (partner ~ '^([A-Z]{2}|WLD|M49:[0-9]{1,4})$'),
  hs6         text    not null check (hs6 ~ '^[0-9]{6}$'),
  year        int     not null check (year between 1988 and 2100),
  value_usd   bigint  not null check (value_usd >= 0),
  qty         numeric null,
  ingested_at timestamptz not null default now(),
  primary key (reporter, partner, hs6, year)
);
create index trade_flow_reporter_year_idx on analytics.trade_flow (reporter, year);

create table analytics.market_row (
  country          text   not null check (country ~ '^[A-Z]{2}$'),
  hs6              text   not null check (hs6 ~ '^([0-9]{6}|[0-9]{4}__)$'),
  data_year        int    not null,
  import_value_usd bigint not null check (import_value_usd >= 0),
  cagr_5y          real   null,
  india_share      real   null check (india_share is null or (india_share >= 0 and india_share <= 1)),
  top_suppliers    jsonb  not null default '[]'::jsonb,  -- [{country, share}] top 5
  fta_ref          text   null,
  score            real   not null,
  rank             int    not null check (rank >= 1),
  why_text         text   null check (why_text is null or length(why_text) <= 1200),
  why_input_hash   text   not null check (why_input_hash ~ '^[0-9a-f]{64}$'),
  hs_version       text   not null,
  built_at         timestamptz not null default now(),
  primary key (country, hs6)
);
-- IF-14a reads the top N of one code by rank.
create index market_row_code_rank_idx on analytics.market_row (hs6, rank);

create table analytics.fta (
  partner       text not null check (partner ~ '^[A-Z]{2}$'),
  agreement     text not null check (length(agreement) between 1 and 200),
  in_force_from date not null,
  hs_scope      text not null default 'all' check (hs_scope ~ '^(all|[0-9]{2}(-[0-9]{2})?(,[0-9]{2}(-[0-9]{2})?)*)$'),
  notes         text null,
  source_url    text null check (source_url is null or source_url ~ '^https?://'),
  primary key (partner, agreement)
);

-- Curated seed: India's agreements in force [tunable; operators maintain this table].
insert into analytics.fta (partner, agreement, in_force_from, hs_scope, notes, source_url) values
  ('AE', 'India–UAE CEPA', '2022-05-01', 'all', 'Comprehensive Economic Partnership Agreement.', 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('AU', 'India–Australia ECTA', '2022-12-29', 'all', 'Economic Cooperation and Trade Agreement.', 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('JP', 'India–Japan CEPA', '2011-08-01', 'all', null, 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('KR', 'India–Korea CEPA', '2010-01-01', 'all', null, 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('SG', 'India–Singapore CECA', '2005-08-01', 'all', null, 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('MY', 'India–Malaysia CECA', '2011-07-01', 'all', null, 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('MY', 'ASEAN–India Trade in Goods Agreement', '2010-01-01', 'all', null, 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('TH', 'ASEAN–India Trade in Goods Agreement', '2010-01-01', 'all', null, 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('VN', 'ASEAN–India Trade in Goods Agreement', '2010-01-01', 'all', null, 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('ID', 'ASEAN–India Trade in Goods Agreement', '2010-01-01', 'all', null, 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('PH', 'ASEAN–India Trade in Goods Agreement', '2010-01-01', 'all', null, 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('LK', 'India–Sri Lanka FTA', '2000-03-01', 'all', null, 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('NP', 'India–Nepal Treaty of Trade', '2009-10-27', 'all', null, 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('BD', 'SAFTA', '2006-01-01', 'all', 'South Asian Free Trade Area.', 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('CH', 'India–EFTA TEPA', '2025-10-01', 'all', 'Trade and Economic Partnership Agreement.', 'https://commerce.gov.in/international-trade/trade-agreements/'),
  ('NO', 'India–EFTA TEPA', '2025-10-01', 'all', 'Trade and Economic Partnership Agreement.', 'https://commerce.gov.in/international-trade/trade-agreements/')
on conflict (partner, agreement) do nothing;

-- Serving plane: IF-14a reads market rows and the FTA table.
grant usage on schema analytics to app_serving;
grant select on analytics.market_row, analytics.fta to app_serving;

-- migrate:down

revoke select on analytics.market_row, analytics.fta from app_serving;
drop table if exists analytics.fta;
drop table if exists analytics.market_row;
drop table if exists analytics.trade_flow;
