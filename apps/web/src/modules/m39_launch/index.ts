/**
 * M39 Launch hardening — public API. Other modules import ONLY from this file.
 * REQ-057 (acceptance: mobile performance budgets, load test), REQ-028 (wording audit),
 * REQ-066 (promise audit, folded into the same wording audit), REQ-004 and REQ-051 (abuse
 * limits: per-account search-page caps, sequential-page velocity challenge).
 *
 *   antiScrape.ts        Per-account daily search-page cap + velocity challenge.
 *   routes.ts            Hardened /api/buyers/search + /api/buyers/discovery-status.
 *   degradedSearch.ts    "Search API down" -> "try later" (EV-05 discovery.completed).
 *   exportCanaryWatch.ts Monthly web-search alert job over M35's export canaries.
 *   costPerCredit.ts     analytics.v_cost_per_credit dashboard + admin route.
 *   activation.ts        analytics.activation, fed by EV-08/EV-09.
 *   wordingAudit.ts       "verified genuine" / "guaranteed buyer" / "100% genuine" audit.
 *
 * Call `registerLaunchHardeningModule()` once at boot (web and worker); see jobs.ts.
 */
export { loadLaunchHardeningConfig, launchHardeningConfig, setLaunchHardeningConfig } from './config.js';
export type { LaunchHardeningConfig } from './config.js';

export {
  LAUNCH_HARDENING_MESSAGES_EN,
  LAUNCH_HARDENING_NAMESPACE,
  resolveLaunchHardeningLabels,
} from './labels.js';
export type { LaunchHardeningLabelKey, LaunchHardeningLabels } from './labels.js';

export {
  cloudflareTurnstile,
  dailyCapFor,
  guardAccountSearchPage,
  isPaidPlan,
  SECRET_TURNSTILE,
  setAntiScrapeTurnstileVerifier,
} from './antiScrape.js';
export type { TurnstileVerifier } from './antiScrape.js';

export {
  DEGRADED_FLAG_TTL_SEC,
  discoveryStatusDetailed,
  onDiscoveryCompleted,
  registerDegradedSearchWatch,
  resetDegradedSearchWatchForTesting,
  searchDownFlags,
} from './degradedSearch.js';
export type { DiscoveryStatusWithDownDto } from './degradedSearch.js';

export {
  registerHardenedBuyerSearchRoutes,
} from './routes.js';
export type {
  HardenedBuyerSearchResponseDto,
  HardenedBuyerSearchRouteApp,
  HardenedRouteReply,
  HardenedRouteRequest,
} from './routes.js';

export {
  CANARY_WATCH_JOB,
  SECRET_WEB_SEARCH_API_KEY,
  defaultWebSearchTransport,
  listActiveCanaries,
  registerExportCanaryWatchJob,
  resetExportCanaryWatchJobForTesting,
  runExportCanaryWatch,
  setWebSearchTransport,
} from './exportCanaryWatch.js';
export type { ActiveCanary, CanaryHit, CanaryWatchResult, WebSearchHit, WebSearchTransport } from './exportCanaryWatch.js';

export { costPerCreditReport, registerCostPerCreditRoutes } from './costPerCredit.js';
export type { CostPerCreditRouteApp, CostPerCreditRow } from './costPerCredit.js';

export {
  RECOMPUTE_SAVED_COUNTS_JOB,
  getActivation,
  recomputeSavedCounts,
  registerActivationTracking,
  resetActivationTrackingForTesting,
  savedCountsByAccount,
  upsertActivation,
} from './activation.js';
export type { ActivationRow, SavedCountRow } from './activation.js';

export {
  FORBIDDEN_WORDING_RE,
  findForbiddenWording,
  runWordingAudit,
  scanContentTree,
  scanMessageCatalogues,
  scanRegisteredLabelSources,
} from './wordingAudit.js';
export type { WordingViolation } from './wordingAudit.js';

export { registerLaunchHardeningModule, resetLaunchHardeningModuleForTesting } from './jobs.js';
