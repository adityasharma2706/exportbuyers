-- M34 Outreach drafting: first contact (LLD M34). REQ-038, REQ-039, REQ-040, REQ-029 (draft block).
--
-- The literal LLD schema already carries both account_id and workspace_id on serving.draft, so
-- (unlike M29/M33's own migrations) there is no column-shape deviation here. The tenant-registry
-- *scope* chosen in repo.ts is nonetheless 'account' (not 'workspace'): POST /api/drafts carries
-- no workspace segment in its URL (the workspace is resolved from the shortlist entry named by
-- `entryId`), and neither do PATCH /api/drafts/:id or POST /api/drafts/:id/handoff — the same
-- routing shape, and the same scoping choice, M33 documents for serving.shortlist_entry.

-- migrate:up

create table serving.draft (
  id              uuid primary key,
  account_id      uuid not null references serving.account (id),
  workspace_id    uuid not null references serving.workspace (id),
  entry_id        uuid not null references serving.shortlist_entry (id),
  kind            text not null check (kind in ('first', 'follow_up_1', 'follow_up_2', 'whatsapp_intro')),
  language        text not null,
  tone            text not null check (tone in ('formal', 'friendly')),
  body_generated  text not null,
  footer          text not null,
  body_edited     text null,
  model           text not null,
  thread_parent   uuid null references serving.draft (id),
  left_via        text null check (left_via is null or left_via in ('copy', 'mailto', 'wa')),
  left_at         timestamptz null,
  created_at      timestamptz not null default now()
);
-- Rate limiting (LLD Rules: "50 drafts per account per day [tunable]") and per-account listing.
create index draft_account_created_idx on serving.draft (account_id, created_at desc);
-- One entry's draft history (POST /api/drafts, the M33 shortlist provider's draftsCount).
create index draft_entry_idx on serving.draft (entry_id, created_at desc);
select platform.enable_tenant_rls('serving.draft'::regclass, false);

-- migrate:down

drop table if exists serving.draft;
