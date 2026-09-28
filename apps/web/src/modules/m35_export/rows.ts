/**
 * M35 — shaping M10's (already export-redacted) docs into one row per company (LLD Job m35.build
 * step 1-2). `search()`/`byIds()` on the 'export' surface already drop every field listed in the
 * row's own `decision.redactedFields` (M10 redact.ts), so this only normalises what remains into
 * one flat shape; it does not need to repeat the redaction itself.
 */
import type { ProfileDoc, SearchDoc } from '../m10_policy/index.js';
import type { ExportRowData } from './types.js';

export function rowFromSearchDoc(doc: SearchDoc): ExportRowData {
  return {
    companyId: doc.company_id,
    name: doc.name,
    country: doc.country,
    city: doc.city,
    buyerType: doc.buyer_type,
    trustLevel: doc.trust_level ?? 'unknown',
    hsHeadings: doc.hs_heading,
    lastActivity: doc.last_activity,
    shipments12m: doc.shipments_12m,
    volumeKg12m: doc.volume_kg_12m,
  };
}

/** ProfileDoc carries no single "last activity" / shipment aggregate the way SearchDoc does
 * (those are per-heading facts under `doc.activity[]`, whose shape is not pinned by IF-10a); a
 * shortlist-sourced export therefore leaves those three columns blank rather than guessing at an
 * undocumented shape. [deviation: LLD Job step 1 does not distinguish the two doc shapes; this is
 * the most faithful reading available from the public ProfileDoc type (M10 types.ts).] */
export function rowFromProfileDoc(doc: ProfileDoc): ExportRowData {
  return {
    companyId: doc.company_id,
    name: doc.name,
    country: doc.country,
    city: doc.city,
    buyerType: doc.buyer_type?.type ?? null,
    trustLevel: doc.trust?.level ?? 'unknown',
    hsHeadings: (doc.hs_headings ?? []).join(', '),
    lastActivity: null,
    shipments12m: null,
    volumeKg12m: null,
  };
}
