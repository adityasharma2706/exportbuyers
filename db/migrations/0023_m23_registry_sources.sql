-- M23 Registry and domain-signal connectors.
-- Enabling REQ-027, REQ-030.
--
-- Registers the sources M23 fetches from that the M08 register does not yet list. GLEIF
-- ('registry.gleif') and Companies House ('registry.gb.ch') are already in 0008 and are not touched.
-- OpenCorporates is registered 'disabled': it is optional, and is switched on (status 'active' plus
-- the OPENCORPORATES_API_TOKEN secret) only once a licence covering our use is in place.
--
-- NOTE: /config/sources.yaml (owned by M08) must carry the same rows; until it does, the M08
-- nightly register drift check reports these ids as present in the database only.

-- migrate:up

insert into knowledge.source
  (id, source_type, can_store, can_display, can_export, retention_days, attribution_text,
   personal_data_class, allowed_regions, status, notes)
values
  ('registry.eu.vies', 'registry', false, true, true, null,
   'VAT number checked with the European Commission VIES service', 'business_contact',
   array['AT','BE','BG','CY','CZ','DE','DK','EE','GR','ES','FI','FR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK','GB'],
   'active', 'EU VIES REST API, on demand only (1 request/s). Trader name and address are shown next to the check. GB is Northern Ireland (XI) only.'),
  ('registry.opencorporates', 'registry', false, true, false, null,
   'Company data from OpenCorporates', 'none', array['*'],
   'disabled', 'Optional registry fallback. Enable only with a licence that allows this use; export stays off.'),
  ('domain.rdap', 'registry', false, true, true, null,
   'Domain registration date from the registry RDAP service', 'none', array['*'],
   'active', 'IANA RDAP bootstrap and registry RDAP servers; only the registration event is used.'),
  ('domain.whois', 'registry', false, true, true, null,
   'Domain registration date from the registry WHOIS service', 'none', array['*'],
   'active', 'Port-43 WHOIS fallback for TLDs without RDAP; only the creation date is parsed, no registrant data is kept.'),
  ('domain.dns', 'website', false, true, true, null,
   'Mail server (MX) records published in the domain''s DNS', 'none', array['*'],
   'active', 'Own DNS lookups.'),
  ('list.freemail', 'directory', true, true, true, null,
   'Free e-mail provider list (community-maintained)', 'none', array['*'],
   'active', 'Monthly refresh into /config/freemail.txt; used only to flag free-mail domains.')
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

update knowledge.source set status = 'disabled'
 where id in ('registry.eu.vies', 'registry.opencorporates', 'domain.rdap', 'domain.whois', 'domain.dns', 'list.freemail');
