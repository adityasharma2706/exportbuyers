/**
 * M26 — shaping M10's SearchResultRow into the wire SearchRowDto (IF-26a), plus the
 * "lower confidence" rule (REQ-024) and the discovery precision-bar release gate (HLD OQ9).
 */
import type { DocFact, SearchDoc, SearchResultRow } from '../m10_policy/index.js';
import { buyerSearchConfig, isDiscoveryReleased } from './config.js';
import type { SearchRowDto } from './types.js';

const PRODUCT_EVIDENCE_ATTR = 'product_evidence';

/** The highest confidence among the facts backing this heading's evidence summary, or null. */
export function strongestEvidenceConfidence(doc: Pick<SearchDoc, 'evidence_summary' | 'facts'>): number | null {
  const ids = new Set((doc.evidence_summary ?? []).map((e) => e.assertion_id));
  if (ids.size === 0) return null;
  const confidences: number[] = [];
  for (const f of (doc.facts ?? []) as DocFact[]) {
    if (f.attribute === PRODUCT_EVIDENCE_ATTR && ids.has(f.assertion_id) && typeof f.confidence === 'number') {
      confidences.push(f.confidence);
    }
  }
  return confidences.length > 0 ? Math.max(...confidences) : null;
}

/**
 * LLD M26: `lowConfidence = strongest evidence confidence < 0.6 OR source type is website only`
 * [tunable]. A company with no web evidence at all (customs/activity-aggregate only) is not
 * penalised: there is nothing "low confidence" about an aggregate shipment record.
 */
export function isLowConfidence(doc: Pick<SearchDoc, 'evidence_summary' | 'facts' | 'strongest_source_type'>): boolean {
  if (doc.strongest_source_type === 'website') return true;
  const confidence = strongestEvidenceConfidence(doc);
  return confidence !== null && confidence < buyerSearchConfig().lowConfidenceThreshold;
}

/**
 * HLD OQ9 precision bar: a row whose only evidence is a web-discovery run (M20) in a country
 * that has not cleared the precision bar is not served yet — "results are stored but not served".
 * Rows backed by any other source type (customs, directory, registry) are unaffected.
 */
export function passesDiscoveryReleaseGate(doc: Pick<SearchDoc, 'strongest_source_type' | 'country'>): boolean {
  if (doc.strongest_source_type !== 'website') return true;
  return isDiscoveryReleased(doc.country);
}

function previewRowDto(preview: NonNullable<SearchResultRow['preview']>): SearchRowDto {
  return {
    companyId: '',
    name: preview.name,
    city: null,
    country: preview.country,
    buyerType: preview.buyerType,
    buyerTypeConfidence: null,
    evidenceSummary: [],
    strongestSourceType: null,
    lowConfidence: false,
    lastActivity: null,
    trustLevel: preview.trustLevel,
    contactTypes: [],
    sanctionsWarning: false,
    decision: { allowed: ['view'] },
  };
}

/** Builds one SearchRowDto. Anonymous rows (M10's redacted preview) carry only the preview fields. */
export function toSearchRowDto(row: SearchResultRow): SearchRowDto {
  if (row.preview) return previewRowDto(row.preview);
  const doc = row.doc;
  return {
    companyId: doc.company_id,
    name: doc.name,
    city: doc.city,
    country: doc.country,
    buyerType: doc.buyer_type,
    buyerTypeConfidence: doc.buyer_type_confidence,
    evidenceSummary: (doc.evidence_summary ?? []).map((e) => ({
      assertionId: e.assertion_id,
      snippet: e.snippet,
      sourceType: e.source_type,
      checkedAt: e.checked_at,
    })),
    strongestSourceType: doc.strongest_source_type,
    lowConfidence: isLowConfidence(doc),
    lastActivity: doc.last_activity,
    trustLevel: doc.trust_level,
    contactTypes: doc.contact_types ?? [],
    sanctionsWarning: row.decision.visibility === 'visible_with_warning',
    decision: { allowed: row.decision.allowed },
  };
}
