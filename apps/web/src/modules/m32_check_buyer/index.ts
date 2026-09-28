/**
 * M32 Check a buyer — public API. Other modules import ONLY from this file.
 * REQ-030 (the standalone check tool), REQ-031 (contextual part — red flags on the buyer profile
 * trust checklist), REQ-051 (limited free use, then credits).
 *
 * IF-32a  POST /api/check
 * IF-32b  evaluateRedFlags(input), evaluateContextual(profile)
 *
 * Call `registerCheckBuyerModule()` once at boot (web process), after M27 has loaded: it registers
 * this module as M27's `redFlags` provider (LLD M27: "Red flags come from
 * M32.evaluateContextual(profile)"), so buyer profile pages show red flags in context.
 */
import { registerProvider as registerBuyerProfileProvider } from '../m27_buyer_profile/index.js';
import { evaluateContextual } from './contextual.js';

export type {
  CheckBuyerConfig,
} from './config.js';
export { checkBuyerConfig, FREEMAIL_DOMAINS, loadCheckBuyerConfig, setCheckBuyerConfig } from './config.js';

export type {
  CheckBuyerRequestDto,
  CheckBuyerResponseDto,
  RedFlag,
  RedFlagId,
  RedFlagRuleInput,
  RedFlagSeverity,
  SanctionsResultOrUnknown,
  TrustAdhocCheckDto,
  TrustAdhocResultDto,
} from './types.js';
export { RED_FLAG_IDS } from './types.js';

export { evaluateRedFlags, hasNameDomainMismatch, isFreemailEmail, makeRedFlag } from './rules.js';
export { evaluateContextual } from './contextual.js';
export { buildAdviceKeys } from './advice.js';
export { nameDomainSimilarity } from './similarity.js';

export {
  configureTrustAdhocClient,
  evaluateAdhocTrust,
  resetTrustAdhocClientForTesting,
  DEFAULT_CLIENT_TIMEOUT_MS,
  RPC_PATH,
  SERVER_TIMEOUT_MS,
} from './client.js';
export type { TrustAdhocClientConfig, TrustAdhocInput, TrustAdhocTransport } from './client.js';

export { checkBuyer, newDomainFromChecks, sanctionsFromChecks } from './service.js';

export { parseCheckBuyerRequest, checkBuyerRequestSchema } from './validate.js';

export { registerCheckBuyerRoutes } from './routes.js';
export type { CheckBuyerRouteApp, CheckBuyerRouteReply, CheckBuyerRouteRequest } from './routes.js';

export { listCheckRuns } from './repo.js';
export type { CheckRunRow } from './repo.js';

export { encryptInput, decryptInput, SECRET_CHECK_ENC_KEY } from './crypto.js';

export { CHECK_BUYER_MESSAGES_EN, CHECK_BUYER_NAMESPACE, fillLabel, resolveCheckBuyerLabels } from './labels.js';
export type { CheckBuyerLabelKey, CheckBuyerLabels } from './labels.js';

export { CheckBuyer } from './components/CheckBuyer.js';
export type { CheckBuyerProps } from './components/CheckBuyer.js';

let registered = false;

/**
 * Wires M32 into the rest of the system: registers this module as M27's `redFlags` provider.
 * Idempotent; call once at boot in the web process (M27's profile page needs it; the worker
 * process has no use for it, unlike M29's reveal provider + job pair).
 */
export function registerCheckBuyerModule(): void {
  if (registered) return;
  registerBuyerProfileProvider('redFlags', { evaluateContextual: (_ctx, profile) => evaluateContextual(profile) });
  registered = true;
}

/** For tests. */
export function resetCheckBuyerModuleForTesting(): void {
  registered = false;
}
