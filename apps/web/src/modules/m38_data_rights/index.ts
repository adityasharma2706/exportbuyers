/**
 * M38 User data rights — public API. Other modules import ONLY from this file. REQ-061.
 *
 * IF-38a  registerContributor({module, export(accountId), erase(accountId), order}) — every
 *         module that stores anything tied to an account_id registers one of these.
 * IF-38b  POST /api/me/data-export -> 202 {requestId} ; GET /api/me/data-export/:id
 *         POST /api/me/delete {confirm:'DELETE'} -> 202 ; POST /api/me/consent/withdraw {purpose}
 *         GET  /grievance (the grievance officer's contact, from M37)
 * Jobs    m38.export  zips every contributor's export to S3 (7-day retention, 24 h pre-signed link)
 *         m38.erase   cancels billing, runs every contributor's erase in order, then account.status
 *                     = 'deleted' (LLD Rules step 4); retention exceptions are recorded and
 *                     surfaced on GET /api/me/delete/:id
 * Event   EV-11 consent.withdrawn{purpose:'core_service'} (from M06) starts the erase flow.
 *
 * Call `registerDataRightsModule()` once at worker boot, after M02, M05, M06, M07, M28, M33, M34
 * and M36 have loaded: it registers the built-in IF-38a contributors, the `m38.export`/`m38.erase`
 * job handlers and the EV-11 subscription. Call `registerDataRightsRoutes(app)` once per HTTP app.
 */
import { registerBuiltinDataRightsContributors } from './contributors.js';
import { registerDataRightsEvents } from './events.js';
import { registerEraseJob } from './eraseJob.js';
import { registerExportJob } from './exportJob.js';

export {
  dataRightsConfig,
  loadDataRightsConfig,
  setDataRightsConfig,
  EXPORT_JOB_TYPE,
  ERASE_JOB_TYPE,
  ERASE_MAX_ATTEMPTS,
  EXPORT_MAX_ATTEMPTS,
  RIGHTS_JOB_QUEUE,
  RIGHTS_RATE_CLASS,
} from './config.js';
export type { DataRightsConfig } from './config.js';

export type {
  ContributorEraseResult,
  ContributorExportFile,
  ContributorExportResult,
  DataExportRequestDto,
  DataExportStatusDto,
  DataRightsContributor,
  DeleteAccountRequestDto,
  DeleteAccountStatusDto,
  RightsRequest,
  RightsRequestKind,
  RightsRequestState,
} from './types.js';
export { RIGHTS_REQUEST_KINDS, RIGHTS_REQUEST_STATES } from './types.js';

export { CONTRIBUTOR_ORDER, registerContributor, registeredContributorModules, resetDataRightsRegistryForTesting } from './registry.js';

export {
  registerBuiltinDataRightsContributors,
  resetBuiltinDataRightsContributorsForTesting,
  cancelSubscriptionIfAny,
} from './contributors.js';

export { presignRightsExportDownload, setS3ClientForTesting } from './presign.js';

export { systemCtxFor } from './systemCtx.js';

export { findRequest, findRequestSystem, insertRequest } from './repo.js';

export { runExport, registerExportJob, resetExportJobForTesting } from './exportJob.js';
export type { ExportJobPayload } from './exportJob.js';

export { runErase, registerEraseJob, resetEraseJobForTesting } from './eraseJob.js';
export type { EraseJobPayload } from './eraseJob.js';

export { onConsentWithdrawn, registerDataRightsEvents, resetDataRightsEventsForTesting } from './events.js';

export {
  getAccountDeletionStatus,
  getDataExportStatus,
  requestAccountDeletion,
  requestDataExport,
} from './service.js';

export { registerDataRightsRoutes } from './routes.js';
export type { DataRightsRouteApp, DataRightsRouteReply, DataRightsRouteRequest } from './routes.js';

let registered = false;

/** Wires M38 into the worker: registers the built-in IF-38a contributors (M05/M06/M07/M28/M33/
 * M34/M36), the `m38.export`/`m38.erase` job handlers and the EV-11 subscription. Idempotent;
 * call once at worker boot, after every contributor module above has finished its own top-level
 * registration (registerTenantTable etc. run on import, so importing this file already guarantees
 * that — see contributors.ts's doc comment). */
export function registerDataRightsModule(): void {
  if (registered) return;
  registerBuiltinDataRightsContributors();
  registerExportJob();
  registerEraseJob();
  registerDataRightsEvents();
  registered = true;
}

/** For tests. */
export function resetDataRightsModuleForTesting(): void {
  registered = false;
}
