/**
 * M13 HS helper — wire DTOs (IF-13a). Type-only imports, so the client component can share them.
 */
import type { ExportPolicy, HsLevel } from '../m12_hs/index.js';

/** Message key of the standard HS disclaimer (M04 <Disclaimer kind="hs" />). */
export const HS_DISCLAIMER_KEY = 'disclaimer.hs';

export interface HsCandidateDto {
  code: string;
  level: HsLevel;
  /** Nomenclature version the code belongs to, e.g. 'ITCHS2022' or 'HS2022'. */
  version: string;
  description: string;
  /** 0..1 */
  confidence: number;
  /** Null when the reranker was unavailable (degraded mode). */
  explanation: string | null;
  /** Present for 8-digit ITC-HS lines only. */
  exportPolicy?: ExportPolicy | null;
  policyUrl?: string | null;
  policyConditions?: string | null;
}

export interface HsSuggestResponse {
  candidates: HsCandidateDto[];
  disclaimerKey: string;
  /** True when the LLM rerank (or the embedding) was unavailable and a fallback was used. */
  degraded: boolean;
}

export interface HsNodeDto {
  code: string;
  level: HsLevel;
  version: string;
  parentCode: string | null;
  description: string;
  descriptionSimple: string | null;
  /** 8-digit ITC-HS lines only; null otherwise. */
  exportPolicy: ExportPolicy | null;
  policyConditions: string | null;
  policyUrl: string | null;
  hasChildren: boolean;
}

/** GET /api/hs/code/:code */
export interface HsCodeDetailDto extends HsNodeDto {
  /** Ancestors from the chapter down to the direct parent. */
  path: HsNodeDto[];
  /** 'pick_8_digit' for 4/6-digit codes: export policy is defined on 8-digit ITC-HS lines only. */
  policyNote: 'pick_8_digit' | null;
  disclaimerKey: string;
}

/** GET /api/hs/browse?parent= */
export interface HsBrowseDto {
  version: string;
  parent: HsCodeDetailDto | null;
  nodes: HsNodeDto[];
}

export interface HsSavedSelectionDto {
  hs: { code: string; level: HsLevel; version: string };
  /** Anonymous saves: false when the visitor has no persisted session, so nothing was stored. */
  persisted: boolean;
}
