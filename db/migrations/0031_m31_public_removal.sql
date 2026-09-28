-- M31 Public removal and correction page (LLD M31).
-- REQ-037 (global suppression across every surface, no visibility window), REQ-064 (every
-- removal/correction request is decided through the M11 review queue).
--
-- serving.public_removal_challenge is the short-lived (24h [tunable]) email-verification
-- challenge between the public POST /api/public/removal and GET /api/public/removal/verify
-- (LLD M31 API IF-31a). It is global, not tenant-scoped: a public visitor has no account, so
-- there is nothing to run platform.enable_tenant_rls() against (same reasoning as M11's
-- serving.review_item, which this table feeds once a token is verified).
--
-- Only the token's sha256 hex digest is stored (token_hash); the raw token lives only in the
-- verification email. A row is consumed at most once (consumed_at, review_item_id) and later
-- purged by the m31.purge_expired_challenges job after challenge_retention_days.

-- migrate:up

create table serving.public_removal_challenge (
  id                 uuid primary key,
  kind               text not null check (kind in ('removal', 'correction')),
  requester_email    text not null check (length(requester_email) between 3 and 320),
  identifiers        jsonb not null check (jsonb_typeof(identifiers) = 'object'),
  matched_company_id uuid null,
  identity_check     text not null check (identity_check in ('ok', 'needs_identity_check')),
  details            text null check (details is null or length(details) <= 2000),
  token_hash         text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at         timestamptz not null,
  consumed_at        timestamptz null,
  review_item_id     uuid null,
  created_at         timestamptz not null default now()
);

create unique index public_removal_challenge_token_uq on serving.public_removal_challenge (token_hash);
-- Sweep target: unconsumed rows past expiry (and, via created_at, consumed rows past retention).
create index public_removal_challenge_sweep_idx on serving.public_removal_challenge (created_at) where consumed_at is null;

-- migrate:down

drop table if exists serving.public_removal_challenge;
