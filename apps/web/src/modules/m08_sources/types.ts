/**
 * M08 source licence register — types shared with the Python knowledge plane (DS-02).
 */
export const SOURCE_TYPES = [
  'customs',
  'website',
  'directory',
  'registry',
  'sanctions',
  'market_stats',
  'nomenclature',
  'user_report',
  'operator',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const PERSONAL_DATA_CLASSES = ['none', 'business_contact', 'named_person'] as const;
export type PersonalDataClass = (typeof PERSONAL_DATA_CLASSES)[number];

export const SOURCE_STATUSES = ['active', 'disabled', 'prohibited'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** '*' in allowedRegions means every region. */
export const ALL_REGIONS = '*';

export interface SourceEntry {
  id: string;
  sourceType: SourceType;
  canStore: boolean;
  canDisplay: boolean;
  canExport: boolean;
  retentionDays: number | null;
  attributionText: string;
  personalDataClass: PersonalDataClass;
  /** ISO 3166-1 alpha-2 codes of data subjects this source may be used for, or '*'. */
  allowedRegions: readonly string[];
  status: SourceStatus;
  notes: string | null;
  updatedAt: Date | null;
}

/** What a caller wants to do with a fact from a source. */
export type SourceUse = 'display' | 'export';
