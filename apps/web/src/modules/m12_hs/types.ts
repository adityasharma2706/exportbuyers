/**
 * M12 HS nomenclature store — public types (knowledge.hs_code / hs_correlation / hs_version).
 *
 * Versions are '<family><yyyy>': family 'HS' holds the WCO chapters, headings and subheadings
 * (2/4/6 digits); family 'ITCHS' holds the DGFT national 8-digit lines with their export policy.
 * An ITC-HS version's 6-digit parents live in the HS version of the same year.
 */

export const HS_LEVELS = ['chapter', 'heading', 'subheading', 'national8'] as const;
export type HsLevel = (typeof HS_LEVELS)[number];

export const HS_LEVEL_DIGITS: Readonly<Record<HsLevel, number>> = Object.freeze({
  chapter: 2,
  heading: 4,
  subheading: 6,
  national8: 8,
});

export const HS_FAMILIES = ['HS', 'ITCHS'] as const;
export type HsFamily = (typeof HS_FAMILIES)[number];

export const EXPORT_POLICIES = ['free', 'restricted', 'prohibited', 'ste'] as const;
export type ExportPolicy = (typeof EXPORT_POLICIES)[number];

export const HS_RELATIONS = ['1:1', '1:n', 'n:1', 'n:n'] as const;
export type HsRelation = (typeof HS_RELATIONS)[number];

/** Embedding dimension of knowledge.hs_code.embedding (M03 `embed` tier). */
export const HS_EMBEDDING_DIM = 1024;

/** EV-12 NomenclatureVersionLoaded — emitted by the Python loaders when a version becomes current. */
export const EV_NOMENCLATURE_VERSION_LOADED = 'nomenclature.version_loaded';
export interface NomenclatureVersionLoaded {
  version: string;
}

/** Licence register ids of the nomenclature sources (attribution via M08 attributionsFor). */
export const HS_SOURCE_IDS: Readonly<Record<HsFamily, string>> = Object.freeze({
  HS: 'nomenclature.wco.hs',
  ITCHS: 'nomenclature.in.itchs',
});

export interface HsNode {
  version: string;
  code: string;
  level: HsLevel;
  parentCode: string | null;
  description: string;
  descriptionEnSimple: string | null;
  /** National (ITC-HS 8-digit) lines only. */
  exportPolicy: ExportPolicy | null;
  policyConditions: string | null;
  policySourceUrl: string | null;
  /** Cosine similarity to the query embedding (vectorSearch results only). */
  similarity?: number;
}

export interface HsCorrelationResult {
  code: string;
  relation: HsRelation;
}

/** Raw knowledge.hs_code row (without the embedding). */
export interface HsCodeRow {
  version: string;
  code: string;
  level: string;
  parent_code: string | null;
  description: string;
  description_en_simple: string | null;
  export_policy: string | null;
  policy_conditions: string | null;
  policy_source_url: string | null;
  similarity?: number | string | null;
}

export interface HsCorrelationRow {
  from_version: string;
  from_code: string;
  to_version: string;
  to_code: string;
  relation: string;
}

export type CorrelationColumn = 'from_code' | 'to_code';

/** Data access used by the IF-12 read API. Replaceable in tests. */
export interface HsRepo {
  children(version: string, parentCode: string | null): Promise<HsCodeRow[]>;
  one(version: string, code: string): Promise<HsCodeRow | undefined>;
  nearest(version: string, embedding: readonly number[], k: number, levels: readonly HsLevel[] | null): Promise<HsCodeRow[]>;
  currentVersion(family: HsFamily): Promise<string | undefined>;
  hasCorrelationTable(fromVersion: string, toVersion: string): Promise<boolean>;
  /** Rows of the (fromVersion → toVersion) table whose `column` equals `code` (exact) or starts with it. */
  correlationRows(
    fromVersion: string,
    toVersion: string,
    column: CorrelationColumn,
    code: string,
    exact: boolean,
  ): Promise<HsCorrelationRow[]>;
}
