-- M17 Sanctions list ingestion and screener (LLD M17). REQ-029; feeds the sanctions check in REQ-027.
--
-- knowledge.sanctions_entry      one row per (list, list_uid) across OFAC SDN, OFAC consolidated
--                                (non-SDN), UN, EU consolidated and UK OFSI. Entries that disappear from
--                                a list are kept with active = false (history for audits).
-- knowledge.sanctions_name       one row per normalised name of an ACTIVE entry; the pg_trgm GIN index
--                                on it is the candidate prefilter (similarity > 0.3).
-- knowledge.sanctions_list_load  the latest successful load per list. IF-17a returns a stored company
--                                screen only when it is newer than the latest load.
-- knowledge.sanctions_screen     the latest screen per subject (company id, or 'adhoc:<sha256>') and
--                                the operator decision (confirmed / cleared) from sanctions.possible_match.
--
-- Additions to the LLD schema (implementation detail, same semantics): first_seen_at / updated_at /
-- content_hash on entries (diffing and "until the matched entries change"), decided_at /
-- decision_entry_ids / input_hash on screens, and the two helper tables above.

-- migrate:up

create table knowledge.sanctions_entry (
  id             uuid        primary key,
  list           text        not null check (list in ('ofac_sdn', 'ofac_cons', 'un', 'eu', 'uk_ofsi')),
  list_uid       text        not null check (length(list_uid) between 1 and 200),
  names          text[]      not null check (cardinality(names) >= 1),
  names_norm     text[]      not null,
  countries      text[]      not null default '{}',
  entity_type    text        not null default 'unknown'
                 check (entity_type in ('individual', 'entity', 'vessel', 'aircraft', 'unknown')),
  list_version   text        not null,
  active         boolean     not null default true,
  content_hash   text        not null check (content_hash ~ '^[0-9a-f]{64}$'),
  first_seen_at  timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (list, list_uid)
);

create index sanctions_entry_active_idx on knowledge.sanctions_entry (list) where active;

create table knowledge.sanctions_name (
  entry_id   uuid not null references knowledge.sanctions_entry (id) on delete cascade,
  name_norm  text not null check (length(name_norm) >= 1),
  primary key (entry_id, name_norm)
);

create index sanctions_name_trgm_idx on knowledge.sanctions_name using gin (name_norm gin_trgm_ops);

create table knowledge.sanctions_list_load (
  list          text        primary key check (list in ('ofac_sdn', 'ofac_cons', 'un', 'eu', 'uk_ofsi')),
  list_version  text        not null,
  loaded_at     timestamptz not null default now(),
  entry_count   integer     not null check (entry_count >= 0),
  added         integer     not null default 0,
  changed       integer     not null default 0,
  removed       integer     not null default 0
);

create table knowledge.sanctions_screen (
  subject_key         text        primary key check (subject_key ~ '^([0-9a-f-]{36}|adhoc:[0-9a-f]{64})$'),
  result              text        not null check (result in ('clear', 'possible', 'hit')),
  raw_result          text        not null check (raw_result in ('clear', 'possible', 'hit')),
  matched_entry_ids   uuid[]      not null default '{}',
  best_score          real        not null default 0,
  list_versions       jsonb       not null default '{}'::jsonb check (jsonb_typeof(list_versions) = 'object'),
  input_hash          text        not null,
  screened_at         timestamptz not null default now(),
  decision            text        null check (decision in ('confirmed', 'cleared')),
  decided_at          timestamptz null,
  decision_entry_ids  uuid[]      null,
  constraint sanctions_screen_decision_complete check ((decision is null) = (decided_at is null))
);

create index sanctions_screen_screened_idx on knowledge.sanctions_screen (screened_at);

-- The knowledge plane (app_knowledge) owns these tables through M01's default privileges. The
-- serving plane never reads them directly: it calls IF-17a and reads sanctions_block from the
-- read models built by M09.

-- migrate:down

drop table if exists knowledge.sanctions_screen;
drop table if exists knowledge.sanctions_list_load;
drop table if exists knowledge.sanctions_name;
drop table if exists knowledge.sanctions_entry;
