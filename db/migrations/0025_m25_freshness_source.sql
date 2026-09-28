-- M25 Freshness and re-verification scheduler.
-- REQ-033 (stale detection and re-check); enabling REQ-034.
--
-- Registers the source M25 writes refreshed contact.<kind> assertions and negations under: our own
-- automated re-check (MX + email-verification vendor, libphonenumber, HTTP reachability), not a
-- fresh crawl of the page. Same pattern as 'trust.engine' (M24, migration 0024): an 'operator'
-- source for our own derived judgement, carrying the same business_contact classification and
-- display/export rights as the 'web.crawl' facts it refreshes or negates.
--
-- NOTE: /config/sources.yaml (owned by M08) must carry the same row; until it does, the M08
-- nightly register drift check reports 'freshness.reverify' as present in the database only
-- (the same deferred-reconciliation gap M24 left for 'trust.engine').

-- migrate:up

insert into knowledge.source
  (id, source_type, can_store, can_display, can_export, retention_days, attribution_text,
   personal_data_class, allowed_regions, status, notes)
values
  ('freshness.reverify', 'operator', false, true, true, null,
   'Our own automated re-verification (MX and mailbox check, phone-number validity, website reachability)',
   'business_contact', array['*'], 'active',
   'M25 freshness scheduler: refreshes checked_at/deliverability on contact.<kind> assertions, or negates a contact that no longer checks out. Never lands raw pages; it re-checks what M22 already extracted.')
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

update knowledge.source set status = 'disabled' where id = 'freshness.reverify';
