/**
 * M40 HS version change re-confirmation — public API. Other modules import ONLY from this file.
 * REQ-009.
 *
 * IF-40a ReconfirmHs  GET /api/hs/reconfirm · POST /api/workspaces/:id/hs/reconfirm {code}
 * EV-12 handler       nomenclature.version_loaded {version} -> m40.flag_workspaces (batch scan)
 *
 * Call registerHsReconfirmModule() once at boot (web and worker), before M02's syncRegistrations().
 */
export { FLAG_WORKSPACES_JOB } from './types.js';
export type { FlagWorkspacesPayload, ReconfirmCandidateDto, ReconfirmItemDto, WorkspaceHsScanRow } from './types.js';

export { DEFAULT_HS_RECONFIRM_CONFIG, hsReconfirmConfig, loadHsReconfirmConfig, setHsReconfirmConfig } from './config.js';
export type { HsReconfirmConfig } from './config.js';

export { decideOutcome } from './decide.js';
export type { ReconfirmDecision } from './decide.js';

export { flagForReconfirm, nextBatch, updateVersionSilently } from './repo.js';

export { registerHsReconfirmModule, resetHsReconfirmModuleForTesting, runFlagWorkspaces } from './jobs.js';

export { listReconfirmations, reconfirmWorkspace } from './service.js';

export { registerHsReconfirmRoutes, workspaceHsDto } from './routes.js';
export type { HsReconfirmRouteApp, HsReconfirmRouteReply, HsReconfirmRouteRequest } from './routes.js';

export {
  HS_RECONFIRM_MESSAGES_EN,
  HS_RECONFIRM_NAMESPACE,
  fillLabel,
  resolveHsReconfirmLabels,
} from './labels.js';
export type { HsReconfirmLabelKey, HsReconfirmLabels } from './labels.js';

export { ReconfirmBanner } from './components/ReconfirmBanner.js';
export type { ReconfirmBannerProps } from './components/ReconfirmBanner.js';
