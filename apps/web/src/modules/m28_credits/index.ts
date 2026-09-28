/**
 * M28 Credits ledger and price catalogue — public API. Other modules import ONLY from this file.
 *
 * IF-28a  quote, hold, commit, release, refund, grant, balance, consumeAllowance,
 *         allowanceRemaining (+ undoAllowance, needed by M29)
 * IF-28b  getCatalogue()
 * IF-28c  GET /api/prices — the price catalogue as configuration, fed from /config/prices.yaml
 * Routes  GET /api/prices; GET /api/credits/balance; GET /api/credits/allowance;
 *         GET /api/credits/history?cursor=
 * Jobs    m28.sweep_expired_holds (every minute); m28.monthly_free_grant (daily, guarded to the
 *         1st of the month IST)
 */

export { PRICE_ACTIONS, catalogueDto, getCatalogue, isPriceAction, parseCatalogueDocument, quote, setCatalogueForTesting } from './catalogue.js';
export type { PriceAction, PriceCatalogue } from './catalogue.js';

export { creditsConfig, loadCreditsConfig, setCreditsConfig } from './config.js';
export type { CreditsConfig } from './config.js';

export { endOfIstMonthUtc, istDateParts, istPeriod, istToUtc } from './time.js';
export type { IstDateParts } from './time.js';

export {
  allowanceRemaining,
  balance,
  commit,
  computeGrantRemaining,
  consumeAllowance,
  expireGrantIfDue,
  grant,
  hold,
  performRelease,
  refund,
  release,
  undoAllowance,
} from './ledger.js';

export { usageHistory } from './history.js';

export { MONTHLY_GRANT_JOB, SWEEP_HOLDS_JOB, registerCreditsJobs, runMonthlyFreeGrant, sweepExpiredHolds } from './jobs.js';

export { registerCreditsRoutes } from './routes.js';
export type { CreditsRouteApp, CreditsRouteReply, CreditsRouteRequest } from './routes.js';

export { CREDITS_MESSAGES_EN, CREDITS_NAMESPACE, fillLabel, resolveCreditsLabels } from './labels.js';
export type { CreditsLabelKey, CreditsLabels } from './labels.js';

export { CreditsHistory } from './components/CreditsHistory.js';
export type { CreditsHistoryProps } from './components/CreditsHistory.js';

export type {
  AllowanceKind,
  Balance,
  CommitOptions,
  CommitResult,
  EntryBucket,
  EntryKind,
  EntryRow,
  GrantKind,
  GrantParams,
  GrantResult,
  HoldParams,
  Quote,
  QuoteOptions,
  RefundParams,
  RefundResult,
  UsageEntry,
  UsageHistoryPage,
  UsageTxn,
} from './types.js';
