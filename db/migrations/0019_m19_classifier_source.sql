-- M19 Buyer classifiers (LLD M19 step 4).
-- REQ-020, REQ-016, REQ-018.
--
-- Registers the source the classifier writes under: logistics_flag and buyer_type assertions use
-- source_id 'operator.classifier' (source type 'operator'). M19 adds no tables of its own; its
-- results live in knowledge.assertion (M09).
--
-- NOTE: /config/sources.yaml (owned by M08) must carry the same row; until it does, the M08
-- nightly register drift check reports 'operator.classifier' as present in the database only.

-- migrate:up

insert into knowledge.source
  (id, source_type, can_store, can_display, can_export, retention_days, attribution_text,
   personal_data_class, allowed_regions, status, notes)
values
  ('operator.classifier', 'operator', false, true, true, null, 'Classified by our system from the evidence shown', 'none', array['*'], 'active', 'M19 automatic classifier: logistics_flag and buyer_type derived from curated lists, name rules and LLM reading of cited evidence.')
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

update knowledge.source set status = 'disabled' where id = 'operator.classifier';
