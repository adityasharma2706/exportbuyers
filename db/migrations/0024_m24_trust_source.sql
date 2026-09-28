-- M24 Trust engine.
-- REQ-027, REQ-028.
--
-- Registers the source M24 writes trust.check.<id> and trust.rollup assertions under. It is our
-- own derived judgement (not a raw fact from an external registry, screener or crawl), so it is
-- an 'operator' source, the same pattern as 'operator.classifier' (M19, migration 0019).
--
-- NOTE: /config/sources.yaml (owned by M08) must carry the same row; until it does, the M08
-- nightly register drift check reports 'trust.engine' as present in the database only.

-- migrate:up

insert into knowledge.source
  (id, source_type, can_store, can_display, can_export, retention_days, attribution_text,
   personal_data_class, allowed_regions, status, notes)
values
  ('trust.engine', 'operator', false, true, true, null,
   'Our own automated trust checks, run against registry, domain, contact, trade-activity and sanctions signals',
   'none', array['*'], 'active',
   'M24 trust engine: pass/fail/unknown per check and a deterministic rollup (RULE_V). Never claims a company is "verified" or "genuine".')
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

update knowledge.source set status = 'disabled' where id = 'trust.engine';
