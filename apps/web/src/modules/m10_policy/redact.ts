/**
 * M10 — applying a decision's `redactedFields` to a projected doc. The decision lists field
 * names from `doc.field_sources`; this removes every item backed by those assertions (any object
 * carrying an `assertion_id` in the set) and blanks the denormalised scalar columns that M09
 * copies into search docs. Returns a new object; the input is not modified.
 */
import { redactedAssertionIds } from './rules.js';
import type { AnonymousSearchPreview, PolicyDecision, ProfileDoc, SearchDoc } from './types.js';

type Json = unknown;

function isRecord(v: Json): v is Record<string, Json> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function carriesRedacted(v: Json, ids: ReadonlySet<string>): boolean {
  return isRecord(v) && typeof v.assertion_id === 'string' && ids.has(v.assertion_id);
}

function strip(v: Json, ids: ReadonlySet<string>): Json {
  if (Array.isArray(v)) return v.filter((x) => !carriesRedacted(x, ids)).map((x) => strip(x, ids));
  if (isRecord(v)) {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) out[k] = carriesRedacted(x, ids) ? null : strip(x, ids);
    return out;
  }
  return v;
}

function withoutFieldSources(fs: Record<string, string[]>, fields: ReadonlySet<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(fs)) if (!fields.has(k)) out[k] = v;
  return out;
}

export function redactSearchDoc(doc: SearchDoc, decision: PolicyDecision): SearchDoc {
  if (decision.redactedFields.length === 0) return doc;
  const fields = new Set(decision.redactedFields);
  const ids = redactedAssertionIds(doc.field_sources ?? {}, decision.redactedFields);
  const out = strip(doc, ids) as SearchDoc;
  out.field_sources = withoutFieldSources(doc.field_sources ?? {}, fields);
  if (fields.has('buyer_type')) {
    out.buyer_type = null;
    out.buyer_type_confidence = null;
  }
  if (fields.has('trust.level')) out.trust_level = 'unknown';
  if (fields.has(`activity.${doc.hs_heading}`)) {
    out.shipments_12m = null;
    out.volume_kg_12m = null;
    out.last_activity = null;
    out.origin_india = 'unknown';
    out.origin_competitor = 'unknown';
  }
  if (fields.has(`evidence.${doc.hs_heading}`)) out.strongest_source_type = null;
  const redactedKinds = [...fields].filter((f) => f.startsWith('contacts.')).map((f) => f.slice('contacts.'.length));
  if (redactedKinds.length > 0) out.contact_types = (doc.contact_types ?? []).filter((k) => !redactedKinds.includes(k));
  return out;
}

export function redactProfileDoc(doc: ProfileDoc, decision: PolicyDecision): ProfileDoc {
  if (decision.redactedFields.length === 0) return doc;
  const fields = new Set(decision.redactedFields);
  const ids = redactedAssertionIds(doc.field_sources ?? {}, decision.redactedFields);
  const out = strip(doc, ids) as ProfileDoc;
  out.field_sources = withoutFieldSources(doc.field_sources ?? {}, fields);
  if (fields.has('trust.level') && out.trust) {
    out.trust = { ...out.trust, level: 'unknown', rollup_assertion_id: null };
  }
  if (out.signals) {
    const signals: ProfileDoc['signals'] = {};
    for (const [k, v] of Object.entries(out.signals)) if (v !== null && !fields.has(`signals.${k}`)) signals[k] = v;
    out.signals = signals;
  }
  if (out.sourcing) {
    const sourcing: ProfileDoc['sourcing'] = {};
    for (const [h, v] of Object.entries(out.sourcing)) if (!fields.has(`activity.${h}`)) sourcing[h] = v;
    out.sourcing = sourcing;
  }
  const kinds = new Set((out.contacts ?? []).filter((s) => s.deliverability !== 'invalid').map((s) => s.kind));
  out.contact_types = (doc.contact_types ?? []).filter((k) => kinds.has(k));
  return out;
}

/** Rule 7: an anonymous search row carries only name, country, buyer type and trust level. */
export function anonymousSearchDoc(doc: SearchDoc): { doc: SearchDoc; preview: AnonymousSearchPreview } {
  const preview: AnonymousSearchPreview = {
    name: doc.name,
    country: doc.country,
    buyerType: doc.buyer_type ?? null,
    trustLevel: doc.trust_level ?? 'unknown',
  };
  const redacted: SearchDoc = {
    company_id: '',
    hs_heading: doc.hs_heading,
    name: doc.name,
    city: null,
    country: doc.country,
    buyer_type: doc.buyer_type ?? null,
    buyer_type_confidence: null,
    evidence_summary: [],
    strongest_source_type: null,
    last_activity: null,
    trust_level: doc.trust_level ?? 'unknown',
    contact_types: [],
    shipments_12m: null,
    volume_kg_12m: null,
    origin_india: 'unknown',
    origin_competitor: 'unknown',
    is_logistics: false,
    sanctions_block: doc.sanctions_block === true,
    assertion_ids: [],
    field_sources: {},
    facts: [],
    non_exportable_assertion_ids: [],
    hidden_assertion_ids: [],
    projection_version: doc.projection_version,
    built_at: doc.built_at,
  };
  return { doc: redacted, preview };
}
