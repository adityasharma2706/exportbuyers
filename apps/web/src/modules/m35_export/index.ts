/**
 * M35 Export to Excel/CSV — public API. Other modules import ONLY from this file. REQ-048.
 *
 * An export job that goes through M10 (IF-10a `search`/`byIds` on the 'export' surface). It
 * includes only contacts the user has revealed (M29 `revealedContacts`) and fields whose licence
 * allows export (M10's own redaction). Limited by plan (`entitlements.exportRowsPerMonth`), with
 * a watermark and a canary row. Exports shortlists (M33) or search results (M10 `SearchQuery`).
 *
 * IF-35a POST /api/exports {source, format} -> 202 {exportId}
 *        GET  /api/exports/:id              -> 200 {state, rows?, downloadUrl?, expiresAt}
 * Job    m35.build       resolves rows, applies the row cap, watermarks, uploads.
 * Event  EV-04 suppression.added            cancels in-flight exports and deletes ready files
 *        that carried a company that was just suppressed.
 *
 * Call `registerExportModule()` once at worker boot, after M02 and M10 have loaded: it registers
 * the `m35.build` job handler and the EV-04 subscription.
 */
import { registerExportBuildJob } from './build.js';
import { registerExportSuppressionHandler } from './events.js';

export {
  EMPTY_CONTACT_COLUMNS,
  EXPORT_FORMATS,
  EXPORT_STATES,
  isShortlistSource,
} from './types.js';
export type {
  BuildJobPayload,
  CreateExportInput,
  CreateExportResponseDto,
  Export,
  ExportContactColumns,
  ExportFormat,
  ExportRow,
  ExportRowData,
  ExportSource,
  ExportState,
  GetExportResponseDto,
  SearchExportSource,
  ShortlistExportSource,
} from './types.js';

export { BUILD_JOB_QUEUE, BUILD_JOB_TYPE, BUILD_RATE_CLASS, exportConfig, loadExportConfig, setExportConfig } from './config.js';
export type { ExportConfig } from './config.js';

export { isExportFormat, parseCreateExportInput, parseExportIdParam } from './validate.js';

export { rowFromProfileDoc, rowFromSearchDoc } from './rows.js';

export { buildCsv, buildXlsx, COLUMN_HEADERS } from './workbook.js';
export type { BuiltWorkbookInput } from './workbook.js';

export { deleteExportObject, presignExportDownload, setS3ClientForTesting } from './presign.js';

export { findExport, monthlyReadyRowUsage } from './repo.js';

export { buildExport, registerExportBuildJob, resetExportBuildJobForTesting } from './build.js';

export { createExport, getExport } from './service.js';

export { registerExportSuppressionHandler, resetExportSuppressionHandlerForTesting } from './events.js';

export { registerExportRoutes } from './routes.js';
export type { ExportRouteApp, ExportRouteReply, ExportRouteRequest } from './routes.js';

let registered = false;

/** Wires M35 into the worker: registers the `m35.build` job handler and the EV-04 subscription.
 * Idempotent; call once at worker boot. */
export function registerExportModule(): void {
  if (registered) return;
  registerExportBuildJob();
  registerExportSuppressionHandler();
  registered = true;
}

/** For tests. */
export function resetExportModuleForTesting(): void {
  registered = false;
}
