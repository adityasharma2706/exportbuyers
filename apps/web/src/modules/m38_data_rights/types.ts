/**
 * M38 — shared types (LLD M38 "API" / "Schema").
 */
import type { Id } from '../m01_platform/index.js';

export const RIGHTS_REQUEST_KINDS = ['export', 'erase'] as const;
export type RightsRequestKind = (typeof RIGHTS_REQUEST_KINDS)[number];

export const RIGHTS_REQUEST_STATES = ['queued', 'running', 'done', 'failed'] as const;
export type RightsRequestState = (typeof RIGHTS_REQUEST_STATES)[number];

// ---- serving.rights_request row shape (db/migrations/0038_m38_data_rights.sql) -----------------

export interface RightsRequestRow {
  id: string;
  account_id: string;
  kind: RightsRequestKind;
  state: RightsRequestState;
  zip_s3_key: string | null;
  retained: unknown;
  created_at: Date;
  completed_at: Date | null;
}

export interface RightsRequest {
  id: Id<'rights_request'>;
  accountId: Id<'account'>;
  kind: RightsRequestKind;
  state: RightsRequestState;
  zipS3Key: string | null;
  /** LLD Rules step 3: the erase job's retention-exception notes (M28/M36/M06), once at least
   * one erase pass has run. Null before then and always null for `export` requests. */
  retained: string[] | null;
  createdAt: Date;
  completedAt: Date | null;
}

// ---- IF-38a: what every contributor module hands back --------------------------------------

/** One file inside the export zip (LLD IF-38a: `export(accountId) -> {files: {name; json}[]}`). */
export interface ContributorExportFile {
  /** File name inside the zip, e.g. "m06_consent.json". Must be unique per contributor. */
  name: string;
  json: unknown;
}

export interface ContributorExportResult {
  files: ContributorExportFile[];
}

/** LLD IF-38a: `erase(accountId) -> {retained?: string[]}` — human-readable notes on what a
 * contributor kept and why (the LLD's "retention list"), e.g. "ledger entries (no personal data)". */
export interface ContributorEraseResult {
  retained?: string[];
}

/** LLD IF-38a: `registerContributor({module, export, erase, order})`. */
export interface DataRightsContributor {
  module: string;
  export(accountId: string): Promise<ContributorExportResult>;
  erase(accountId: string): Promise<ContributorEraseResult>;
  order: number;
}

// ---- wire DTOs -----------------------------------------------------------------------------

export interface DataExportRequestDto {
  requestId: string;
}

export interface DataExportStatusDto {
  requestId: string;
  state: RightsRequestState;
  createdAt: string;
  completedAt: string | null;
  /** S3 pre-signed, valid 24 h (LLD Rules: "the download link is pre-signed for 24 h"). Present
   * only once the export is `done`. */
  downloadUrl?: string;
}

export interface DeleteAccountRequestDto {
  requestId: string;
}

export interface DeleteAccountStatusDto {
  requestId: string;
  state: RightsRequestState;
  createdAt: string;
  completedAt: string | null;
  /** LLD Rules: "M28 keeps the ledger rows...", "M36 keeps invoices for 8 years...", "M06 keeps
   * the consent history...". Populated once the erase has run at least one pass. */
  retained: string[];
}
