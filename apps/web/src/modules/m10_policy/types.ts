/**
 * M10 — public types (LLD M10 "API (TS)" and "SearchQuery").
 */
import type { ActorContext, Entitlements, Id } from '../m01_platform/index.js';

export type Surface = 'search' | 'profile' | 'reveal' | 'draft' | 'export' | 'notify' | 'alert' | 'similar';
export const SURFACES: readonly Surface[] = ['search', 'profile', 'reveal', 'draft', 'export', 'notify', 'alert', 'similar'];

export type Action = 'view' | 'reveal' | 'draft' | 'export' | 'notify';
export const ALL_ACTIONS: readonly Action[] = ['view', 'reveal', 'draft', 'export', 'notify'];

export type ReasonCode =
  | 'SUPPRESSED'
  | 'SANCTIONS_BLOCK'
  | 'LICENCE_REDACTED'
  | 'REGION_REDACTED'
  | 'LOGISTICS_DEFAULT_HIDDEN'
  | 'USER_HIDDEN'
  | 'PLAN_LIMIT'
  | 'CLOSED';

export type Visibility = 'hidden' | 'visible' | 'visible_with_warning';

export interface PolicyDecision {
  visibility: Visibility;
  allowed: Action[];
  redactedFields: string[];
  reasons: ReasonCode[];
}

/** Identifier kinds of the suppression list (DS-06). */
export type IdentifierKind = 'domain' | 'email' | 'phone' | 'company_id' | 'registry';
export const IDENTIFIER_KINDS: readonly IdentifierKind[] = ['domain', 'email', 'phone', 'company_id', 'registry'];

export type SuppressionReason = 'removal_request' | 'operator' | 'legal';
export const SUPPRESSION_REASONS: readonly SuppressionReason[] = ['removal_request', 'operator', 'legal'];

export type TrustLevel = 'high' | 'medium' | 'low' | 'unknown';

/** IF-09d search primitive (HLD OQ6). */
export interface SearchQuery {
  hsHeadings: string[];
  keyword?: string;
  countries: string[];
  buyerTypes?: string[];
  activeWithinMonths?: 3 | 6 | 12;
  minShipments12m?: number;
  trustLevels?: TrustLevel[];
  contactTypes?: string[];
  originIndia?: boolean;
  originCompetitor?: boolean;
  includeLogistics?: boolean;
  sort: 'relevance' | 'recency' | 'volume' | 'trust';
  page: number;
  pageSize: 20 | 50;
}

/** One provenance-carrying fact summary inside a projected doc (built by M09). */
export interface DocFact {
  assertion_id: string;
  attribute: string;
  source_id: string;
  source_type: string;
  observed_at: string | null;
  checked_at: string | null;
  confidence: number;
  llm_assisted: boolean;
  can_export: boolean;
  personal_data_class: 'none' | 'business_contact' | 'named_person';
  region: string | null;
}

/** The JSON of a `search_doc.doc` row (M09 projection, one row per company and HS heading). */
export interface SearchDoc {
  company_id: string;
  hs_heading: string;
  name: string;
  city: string | null;
  country: string;
  buyer_type: string | null;
  buyer_type_confidence: number | null;
  evidence_summary: Array<{ assertion_id: string; snippet: string | null; source_type: string; checked_at: string | null }>;
  strongest_source_type: string | null;
  last_activity: string | null;
  trust_level: TrustLevel | string;
  contact_types: string[];
  shipments_12m: number | null;
  volume_kg_12m: number | null;
  origin_india: 'yes' | 'no' | 'unknown';
  origin_competitor: 'yes' | 'no' | 'unknown';
  is_logistics: boolean;
  sanctions_block: boolean;
  assertion_ids: string[];
  field_sources: Record<string, string[]>;
  facts: DocFact[];
  non_exportable_assertion_ids: string[];
  hidden_assertion_ids: string[];
  projection_version: number;
  built_at: string;
  [extra: string]: unknown;
}

/** The JSON of a `profile_doc.doc` row (M09 projection, one per company). Never holds contact values. */
export interface ProfileDoc {
  company_id: string;
  status: 'active' | 'closed';
  name: string;
  country: string;
  city: string | null;
  website: string | null;
  buyer_type: { type: string | null; confidence: number; source_type: string; assertion_id: string; checked_at: string | null } | null;
  hs_headings: string[];
  evidence: Array<Record<string, unknown> & { assertion_id: string; hs_heading: string }>;
  activity: Array<Record<string, unknown> & { assertion_id: string; hs_heading: string }>;
  sourcing: Record<string, { origin_india: string; origin_competitor: string }>;
  trust: { level: string; rollup_assertion_id: string | null; checks: Array<Record<string, unknown> & { assertion_id: string }> };
  contacts: Array<{ assertion_id: string; kind: string; source_type: string; checked_at: string | null; deliverability: string }>;
  contact_types: string[];
  signals: Record<string, Record<string, unknown> & { assertion_id: string }>;
  is_logistics: boolean;
  sanctions_block: boolean;
  not_buyer_for: string[];
  facts: DocFact[];
  field_sources: Record<string, string[]>;
  hidden_assertion_ids: string[];
  non_exportable_assertion_ids: string[];
  projection_version: number;
  built_at: string;
  [extra: string]: unknown;
}

/** What anonymous visitors see of a search row (LLD M10 rule 7). */
export interface AnonymousSearchPreview {
  name: string;
  country: string;
  buyerType: string | null;
  trustLevel: string;
}

export interface SearchResultRow {
  doc: SearchDoc;
  decision: PolicyDecision;
  /** Present for anonymous visitors only: the four fields they may see. */
  preview?: AnonymousSearchPreview;
}

export interface SearchResult {
  rows: SearchResultRow[];
  total: number;
  shown: number;
  limit?: { cap: number; reason: 'PLAN_LIMIT' };
}

export interface ByIdsEntry {
  doc: ProfileDoc | null;
  decision: PolicyDecision;
}

export interface ByIdsOptions {
  /**
   * REQ-020 toggle for explicit id lookups. Defaults to `false` on the discovery surface
   * `similar` (logistics hidden by default) and `true` on surfaces where the caller asked for a
   * specific company (profile, reveal, draft, export, notify, alert).
   */
  includeLogistics?: boolean;
}

/** IF-10b providers. */
export interface UserHidesProvider {
  hiddenCompanies(accountId: Id<'account'> | string): Promise<Set<string>>;
  hiddenAssertions(accountId: Id<'account'> | string): Promise<Set<string>>;
}

export interface EntitlementsProvider {
  get(accountId: Id<'account'> | string | null): Promise<Entitlements>;
}

export type ProviderKind = 'userHides' | 'entitlements';

export type { ActorContext, Entitlements, Id };
