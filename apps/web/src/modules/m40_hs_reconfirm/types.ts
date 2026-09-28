/**
 * M40 HS version change re-confirmation — public types.
 *
 * IF-40a ReconfirmHs: GET /api/hs/reconfirm lists flagged workspaces (with freshly correlated
 * candidates); POST /api/workspaces/:id/hs/reconfirm {code} resolves one, through IF-07a
 * (M07 `setHsCode`, which clears `hs_needs_reconfirm`).
 * EV-12 `nomenclature.version_loaded {version}` (M12) drives the batch scan below.
 */
import type { HsLevel, HsRelation } from '../m12_hs/index.js';

/** Job type of the batch scan enqueued from the EV-12 handler (kept off the event's own transaction). */
export const FLAG_WORKSPACES_JOB = 'm40.flag_workspaces';

export interface FlagWorkspacesPayload {
  v: 1;
  /** The nomenclature version that just became current. */
  version: string;
}

export interface ReconfirmCandidateDto {
  code: string;
  relation: HsRelation;
}

/** One row of GET /api/hs/reconfirm. */
export interface ReconfirmItemDto {
  workspaceId: string;
  workspaceName: string;
  oldCode: string;
  oldVersion: string;
  /** The current nomenclature version for this code's level — what the user is being asked to move to. */
  newVersion: string;
  level: HsLevel;
  /** Correlated codes in `newVersion`; empty when no correlation table covers this code (the UI offers a fresh search instead). */
  candidates: ReconfirmCandidateDto[];
}

/** The columns of serving.workspace (M07's table) read by the cross-tenant scan — a plain subset, not the full M07 row shape. */
export interface WorkspaceHsScanRow {
  id: string;
  account_id: string;
  name: string;
  hs_code: string;
  hs_level: string;
  hs_version: string;
}
