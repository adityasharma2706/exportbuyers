/**
 * M35 — shared types (LLD M35 "API (IF-35a)" / "Schema" / "Job m35.build").
 */
import type { Entitlements } from '../m01_platform/index.js';
import type { SearchQuery } from '../m10_policy/index.js';
import type { ShortlistStatus } from '../m33_pipeline/index.js';

export const EXPORT_FORMATS = ['xlsx', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_STATES = ['queued', 'running', 'ready', 'failed', 'cancelled'] as const;
export type ExportState = (typeof EXPORT_STATES)[number];

/** LLD M35 API: `source: {shortlist: {workspaceId, status?}} | {search: SearchQuery}`. */
export interface ShortlistExportSource {
  shortlist: { workspaceId: string; status?: ShortlistStatus };
}
export interface SearchExportSource {
  search: SearchQuery;
}
export type ExportSource = ShortlistExportSource | SearchExportSource;

export function isShortlistSource(s: ExportSource): s is ShortlistExportSource {
  return 'shortlist' in s;
}

// ---- serving.export row shape (db/migrations/0035_m35_export.sql) -----------------------------
//
// [deviation: the LLD's literal schema for serving.export is {id, account_id, source, format,
// state, row_count, s3_key, canary_ids, created_at, expires_at}. Two columns are added here:
// `company_ids` (LLD Rules: "the check [for EV-04] uses a company_ids list kept alongside each
// export" — the literal column list has nowhere to keep that list) and `updated_at` (every other
// table in this codebase tracks it across the same kind of state-machine transitions this row
// goes through: queued -> running -> ready/failed/cancelled). Every column the LLD does list is
// unchanged.]

export interface ExportRow {
  id: string;
  account_id: string;
  source: ExportSource;
  format: ExportFormat;
  state: ExportState;
  row_count: number | null;
  s3_key: string | null;
  canary_ids: string[];
  company_ids: string[];
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

export interface Export {
  id: string;
  accountId: string;
  source: ExportSource;
  format: ExportFormat;
  state: ExportState;
  rowCount: number | null;
  s3Key: string | null;
  canaryIds: string[];
  companyIds: string[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

// ---- IF-35a wire DTOs ---------------------------------------------------------------------------

export interface CreateExportInput {
  source: ExportSource;
  format: ExportFormat;
}

export interface CreateExportResponseDto {
  exportId: string;
}

export interface GetExportResponseDto {
  state: ExportState;
  rows?: number;
  /** S3 pre-signed, valid 15 minutes (LLD IF-35a). Present only once the file is `ready`. */
  downloadUrl?: string;
  expiresAt: string;
}

// ---- m35.build job payload ----------------------------------------------------------------------

/** Background-job payload (no HTTP request available to a worker; mirrors M29's BulkJobPayload). */
export interface BuildJobPayload {
  v: 1;
  exportId: string;
  accountId: string;
  memberId: string;
  workspaceId?: string;
  role?: string;
  region: string;
  locale: 'en' | 'hi';
  mfaVerified: boolean;
  entitlements: Entitlements;
  source: ExportSource;
  format: ExportFormat;
}

// ---- row shaping (rows.ts) ------------------------------------------------------------------

/** One row's non-contact content, normalised from either a SearchDoc or a ProfileDoc. */
export interface ExportRowData {
  companyId: string;
  name: string;
  country: string;
  city: string | null;
  buyerType: string | null;
  trustLevel: string;
  hsHeadings: string;
  lastActivity: string | null;
  shipments12m: number | null;
  volumeKg12m: number | null;
}

/** Contact columns (LLD Rules step 2: "Contact columns are filled only from revealedContacts(ctx)"). */
export interface ExportContactColumns {
  email: string;
  phone: string;
  website: string;
  whatsapp: string;
  formUrl: string;
  address: string;
}

export const EMPTY_CONTACT_COLUMNS: ExportContactColumns = {
  email: '',
  phone: '',
  website: '',
  whatsapp: '',
  formUrl: '',
  address: '',
};
