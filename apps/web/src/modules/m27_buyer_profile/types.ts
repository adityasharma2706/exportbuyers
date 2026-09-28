/**
 * M27 — wire DTOs (IF-27a).
 *
 *   GET /api/buyers/:companyId?workspaceId= → BuyerProfileResponseDto
 *
 * Shapes follow the M09 profile projection (`py/kp/m09_evidence/projection.py:build_projection`),
 * read here only through M10's `ProfileDoc` (LLD M10: "the only file allowed to reference these
 * views" is M10's own `readModelStore.ts`; M27 never queries `v_profile_doc` directly).
 */
import type { PolicyDecision } from '../m10_policy/index.js';

export type SourcingFlag = 'yes' | 'no' | 'unknown';
export type TrustLevelValue = 'high' | 'medium' | 'low' | 'unknown';
export type TrustOutcomeValue = 'pass' | 'fail' | 'unknown';

export interface EvidenceItemDto {
  assertionId: string;
  hsHeading: string;
  snippet: string | null;
  url: string | null;
  sourceType: string;
  observedAt: string | null;
  checkedAt: string | null;
  confidence: number;
  llmAssisted: boolean;
}

export interface ActivityItemDto {
  assertionId: string;
  hsHeading: string;
  shipments12m: number | null;
  volumeKg12m: number | null;
  lastSeen: string | null;
  /** Origin country (ISO alpha-2) → shipment/volume weight. Doubles as "main supplier countries". */
  origins: Record<string, number>;
  sourceType: string;
  checkedAt: string | null;
}

/** REQ-022: present only for headings the buyer has activity for (LLD "unknown ... is different
 * from No"). A heading absent from `ProfileDto.sourcing` has no shipment data at all (unknown);
 * 'no' is an affirmative answer backed by activity data that shows no such origin. */
export interface SourcingDto {
  originIndia: SourcingFlag;
  originCompetitor: SourcingFlag;
}

/** REQ-021: contact *types* only — no values before reveal (M29). */
export interface ContactTypeDto {
  assertionId: string;
  kind: string;
  sourceType: string;
  checkedAt: string | null;
  deliverability: string;
}

export interface BuyerTypeDto {
  type: string | null;
  confidence: number;
  sourceType: string;
  assertionId: string;
  checkedAt: string | null;
}

/** REQ-027: one row per M24 check. */
export interface TrustCheckItemDto {
  id: string;
  outcome: TrustOutcomeValue;
  explanationKey: string | null;
  assertionId: string;
  sourceType: string | null;
  checkedAt: string | null;
}

/** REQ-028: the rollup. Wording (including the disclaimer) is rendered from `level` and
 * `checks[].explanationKey` through M37 keys; this DTO never carries rendered text. */
export interface TrustDto {
  level: TrustLevelValue;
  rollupAssertionId: string | null;
  checks: TrustCheckItemDto[];
}

export interface ProfileActionDto {
  allowed: boolean;
  /** Set only when `allowed` is false; an M37 key explaining why (REQ-029 for sanctions). */
  explanationKey?: string;
}

export interface ProfileActionsDto {
  reveal: ProfileActionDto;
  draft: ProfileActionDto;
  export: ProfileActionDto;
}

export interface ProfileDto {
  companyId: string;
  status: 'active' | 'closed';
  name: string;
  country: string;
  city: string | null;
  website: string | null;
  buyerType: BuyerTypeDto | null;
  hsHeadings: string[];
  /** REQ-017 "why this buyer" evidence: source type, snippet and last-seen/checked date. */
  evidence: EvidenceItemDto[];
  /** REQ-021 activity/shipment summary, one entry per HS heading with customs activity. */
  activity: ActivityItemDto[];
  /** REQ-022, keyed by HS heading. */
  sourcing: Record<string, SourcingDto>;
  trust: TrustDto;
  contacts: ContactTypeDto[];
  contactTypes: string[];
  isLogistics: boolean;
  /** REQ-029: true when this company carries a sanctions/denied-party flag (`visible_with_warning`). */
  sanctionsWarning: boolean;
  actions: ProfileActionsDto;
  builtAt: string;
}

export type RedFlagSeverity = 'high' | 'medium' | 'low';

/** Filled by M32's `evaluateContextual` once it exists; empty until a provider is registered. */
export interface RedFlagDto {
  id: string;
  severity: RedFlagSeverity;
  explanationKey: string;
  detail?: Record<string, unknown>;
}

/** Reserved shape for the workspace's shortlist entry (status/notes/drafts), per this LLD
 * entry's "placeholders for drafts, notes and status (filled by M33/M34)". M27 does not compute
 * these fields itself; `providers.ts`'s `shortlistEntryFor` returns `undefined` until M33/M34
 * register a `ShortlistProvider` that fills this shape from their own storage. */
export interface ShortlistEntryDto {
  status: string | null;
  notesCount: number;
  draftsCount: number;
}

export interface BuyerProfileResponseDto {
  profile: ProfileDto;
  decision: PolicyDecision;
  redFlags: RedFlagDto[];
  /** Whether *this account* has already revealed this company's contacts (M29). False until a
   * `revealed` provider is registered. */
  revealed: boolean;
  /** Present only when a workspace id was resolved and a shortlist provider answered. */
  shortlistEntry?: ShortlistEntryDto;
  /** Set when `:companyId` resolved to a different, current company id (`v_company_redirect`,
   * HLD OQ3 merges). */
  redirectedFrom?: string;
}

export const PROFILE_DISCLAIMER_KEY = 'disclaimer.trust';
export const SANCTIONS_DISCLAIMER_KEY = 'disclaimer.sanctions';
