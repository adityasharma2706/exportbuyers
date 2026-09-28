/**
 * M26 — wire DTOs (IF-26a).
 *
 *   POST /api/buyers/search                         → BuyerSearchResponseDto
 *   GET  /api/buyers/discovery-status?heading&countries → DiscoveryStatusResponseDto
 */
import type { CoverageCellDto } from '../m04_ui/index.js';

export type DiscoveryState = 'idle' | 'running' | 'done';

export interface EvidenceSummaryItemDto {
  assertionId: string;
  snippet: string | null;
  sourceType: string;
  checkedAt: string | null;
}

/** LLD M26: `SearchRowDto = {companyId, name, city, country, buyerType, buyerTypeConfidence,
 * evidenceSummary, strongestSourceType, lowConfidence, lastActivity, trustLevel, contactTypes,
 * sanctionsWarning, decision.allowed}`. */
export interface SearchRowDto {
  companyId: string;
  name: string;
  city: string | null;
  country: string;
  buyerType: string | null;
  buyerTypeConfidence: number | null;
  evidenceSummary: EvidenceSummaryItemDto[];
  strongestSourceType: string | null;
  /** REQ-024: strongest evidence confidence below the threshold, or website-only evidence. */
  lowConfidence: boolean;
  lastActivity: string | null;
  trustLevel: string;
  contactTypes: string[];
  sanctionsWarning: boolean;
  decision: { allowed: string[] };
}

export interface BuyerSearchLimitDto {
  cap: number;
  reason: 'PLAN_LIMIT';
}

export interface BuyerSearchResponseDto {
  rows: SearchRowDto[];
  total: number;
  shown: number;
  limit?: BuyerSearchLimitDto;
  /** One coverage cell per requested country (M15), for the query's primary HS heading. */
  coverage: Record<string, CoverageCellDto>;
  /** One discovery state per requested country (IF-20a), for the "finding more buyers…" banner. */
  discovery: Record<string, DiscoveryState>;
  /** True for anonymous visitors: `rows` carries only the redacted preview fields (REQ-004). */
  previewMode: boolean;
}

export type DiscoveryStatusResponseDto = Record<string, DiscoveryState>;

/** i18n keys used outside the per-module namespace (M04 components read these directly). */
export const BUYER_SEARCH_DISCLAIMER_KEY = 'disclaimer.coverage';
export const SIGNUP_GATE_REASON = 'buyerSearch';
