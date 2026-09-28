/**
 * M27 — shapes M10's (already-redacted) `ProfileDoc` into the wire `ProfileDto` (IF-27a).
 *
 * Field names below mirror `py/kp/m09_evidence/projection.py:build_projection` exactly (its
 * `profile_doc` dict is the only producer of this shape): evidence/activity/contacts/signals are
 * per-fact dicts keyed in snake_case, and `trust.checks[]` entries are
 * `{id, outcome, explanation_key, assertion_id, source_type, checked_at}`. `ProfileDoc`'s TS type
 * (M10) deliberately leaves these as `Record<string, unknown>` so M10 does not have to track M09's
 * internal shape; this file is where that contract is read defensively.
 */
import type { Action, PolicyDecision, ProfileDoc, ReasonCode } from '../m10_policy/index.js';
import type {
  ActivityItemDto,
  BuyerTypeDto,
  ContactTypeDto,
  EvidenceItemDto,
  ProfileActionDto,
  ProfileActionsDto,
  ProfileDto,
  SourcingDto,
  TrustCheckItemDto,
  TrustDto,
  TrustLevelValue,
  TrustOutcomeValue,
} from './types.js';

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean {
  return v === true;
}

function toEvidenceItem(raw: unknown): EvidenceItemDto | null {
  if (!isRecord(raw) || typeof raw.assertion_id !== 'string' || typeof raw.hs_heading !== 'string') return null;
  return {
    assertionId: raw.assertion_id,
    hsHeading: raw.hs_heading,
    snippet: str(raw.snippet),
    url: str(raw.url),
    sourceType: strOr(raw.source_type, 'unknown'),
    observedAt: str(raw.observed_at),
    checkedAt: str(raw.checked_at),
    confidence: num(raw.confidence) ?? 0,
    llmAssisted: bool(raw.llm_assisted),
  };
}

function toOrigins(v: unknown): Record<string, number> {
  if (!isRecord(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  return out;
}

function toActivityItem(raw: unknown): ActivityItemDto | null {
  if (!isRecord(raw) || typeof raw.assertion_id !== 'string' || typeof raw.hs_heading !== 'string') return null;
  return {
    assertionId: raw.assertion_id,
    hsHeading: raw.hs_heading,
    shipments12m: num(raw.shipments_12m),
    volumeKg12m: num(raw.volume_kg_12m),
    lastSeen: str(raw.last_seen),
    origins: toOrigins(raw.origins),
    sourceType: strOr(raw.source_type, 'unknown'),
    checkedAt: str(raw.checked_at),
  };
}

function toFlag(v: unknown): 'yes' | 'no' | 'unknown' {
  return v === 'yes' || v === 'no' ? v : 'unknown';
}

function toSourcing(doc: ProfileDoc): Record<string, SourcingDto> {
  const out: Record<string, SourcingDto> = {};
  const raw = doc.sourcing;
  if (!isRecord(raw)) return out;
  for (const [heading, v] of Object.entries(raw)) {
    if (!isRecord(v)) continue;
    out[heading] = { originIndia: toFlag(v.origin_india), originCompetitor: toFlag(v.origin_competitor) };
  }
  return out;
}

function toContact(raw: unknown): ContactTypeDto | null {
  if (!isRecord(raw) || typeof raw.assertion_id !== 'string') return null;
  return {
    assertionId: raw.assertion_id,
    kind: strOr(raw.kind, 'unknown'),
    sourceType: strOr(raw.source_type, 'unknown'),
    checkedAt: str(raw.checked_at),
    deliverability: strOr(raw.deliverability, 'unknown'),
  };
}

function toBuyerType(raw: unknown): BuyerTypeDto | null {
  if (!isRecord(raw)) return null;
  return {
    type: str(raw.type),
    confidence: num(raw.confidence) ?? 0,
    sourceType: strOr(raw.source_type, 'unknown'),
    assertionId: strOr(raw.assertion_id, ''),
    checkedAt: str(raw.checked_at),
  };
}

const TRUST_OUTCOMES: ReadonlySet<string> = new Set(['pass', 'fail', 'unknown']);
const TRUST_LEVELS: ReadonlySet<string> = new Set(['high', 'medium', 'low', 'unknown']);

function toTrustCheck(raw: unknown): TrustCheckItemDto | null {
  if (!isRecord(raw) || typeof raw.assertion_id !== 'string') return null;
  const outcome = raw.outcome;
  return {
    id: strOr(raw.id, 'unknown'),
    outcome: (typeof outcome === 'string' && TRUST_OUTCOMES.has(outcome) ? outcome : 'unknown') as TrustOutcomeValue,
    explanationKey: str(raw.explanation_key),
    assertionId: raw.assertion_id,
    sourceType: str(raw.source_type),
    checkedAt: str(raw.checked_at),
  };
}

function toTrust(doc: ProfileDoc): TrustDto {
  const raw: Raw = isRecord(doc.trust) ? doc.trust : {};
  const level = raw.level;
  const checks = Array.isArray(raw.checks) ? raw.checks.map(toTrustCheck).filter((c): c is TrustCheckItemDto => c !== null) : [];
  return {
    level: (typeof level === 'string' && TRUST_LEVELS.has(level) ? level : 'unknown') as TrustLevelValue,
    rollupAssertionId: str(raw.rollup_assertion_id),
    checks,
  };
}

/** REQ-029: explanation keys under `buyerProfile.action.blocked.*` (M37 catalogue). */
const REASON_EXPLANATION: Partial<Record<ReasonCode, string>> = {
  SANCTIONS_BLOCK: 'buyerProfile.action.blocked.sanctions',
  CLOSED: 'buyerProfile.action.blocked.closed',
  PLAN_LIMIT: 'buyerProfile.action.blocked.planLimit',
  LICENCE_REDACTED: 'buyerProfile.action.blocked.licence',
  REGION_REDACTED: 'buyerProfile.action.blocked.region',
  SUPPRESSED: 'buyerProfile.action.blocked.other',
  USER_HIDDEN: 'buyerProfile.action.blocked.other',
  LOGISTICS_DEFAULT_HIDDEN: 'buyerProfile.action.blocked.other',
};

/** Sanctions outranks every other reason when explaining a disabled action (REQ-029's warning
 * must be the one the user sees, not an incidental plan limit). */
const REASON_PRIORITY: readonly ReasonCode[] = [
  'SANCTIONS_BLOCK',
  'CLOSED',
  'LICENCE_REDACTED',
  'REGION_REDACTED',
  'PLAN_LIMIT',
  'SUPPRESSED',
  'USER_HIDDEN',
  'LOGISTICS_DEFAULT_HIDDEN',
];

function actionFor(decision: PolicyDecision, action: Action): ProfileActionDto {
  if (decision.allowed.includes(action)) return { allowed: true };
  const reason = REASON_PRIORITY.find((r) => decision.reasons.includes(r)) ?? decision.reasons[0];
  const key = (reason && REASON_EXPLANATION[reason]) ?? 'buyerProfile.action.blocked.other';
  return { allowed: false, explanationKey: key };
}

function toActions(decision: PolicyDecision): ProfileActionsDto {
  return {
    reveal: actionFor(decision, 'reveal'),
    draft: actionFor(decision, 'draft'),
    export: actionFor(decision, 'export'),
  };
}

/** Builds the wire `ProfileDto` from M10's redacted `ProfileDoc` + its `PolicyDecision`. */
export function toProfileDto(doc: ProfileDoc, decision: PolicyDecision): ProfileDto {
  const evidence = Array.isArray(doc.evidence) ? doc.evidence.map(toEvidenceItem).filter((e): e is EvidenceItemDto => e !== null) : [];
  const activity = Array.isArray(doc.activity) ? doc.activity.map(toActivityItem).filter((a): a is ActivityItemDto => a !== null) : [];
  const contacts = Array.isArray(doc.contacts) ? doc.contacts.map(toContact).filter((c): c is ContactTypeDto => c !== null) : [];

  return {
    companyId: doc.company_id,
    status: doc.status === 'closed' ? 'closed' : 'active',
    name: doc.name,
    country: doc.country,
    city: doc.city ?? null,
    website: doc.website ?? null,
    buyerType: toBuyerType(doc.buyer_type),
    hsHeadings: Array.isArray(doc.hs_headings) ? [...doc.hs_headings] : [],
    evidence,
    activity,
    sourcing: toSourcing(doc),
    trust: toTrust(doc),
    contacts,
    contactTypes: Array.isArray(doc.contact_types) ? [...doc.contact_types] : [],
    isLogistics: doc.is_logistics === true,
    // REQ-029: a prominent warning; sourced from the decision, not the raw doc flag, since the
    // decision is what M10 actually enforced (e.g. it also covers a screener flip mid-request).
    sanctionsWarning: decision.visibility === 'visible_with_warning',
    actions: toActions(decision),
    builtAt: doc.built_at,
  };
}
