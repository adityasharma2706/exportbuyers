/**
 * M17 Sanctions list ingestion and screener — serving-plane public API. Other modules import ONLY
 * from this file. (Ingestion, matching and the screener itself live in py/kp/m17_sanctions.)
 *
 * IF-17a screen(ctx, {companyId} | {name, country?}) → 'clear' | 'possible' | 'hit'
 *        Fails closed: timeout / 5xx → UPSTREAM_UNAVAILABLE, and the action is not performed.
 *        assertSanctionsClear(ctx, companyId) — reveal / draft guard (hit or possible → SANCTIONS_BLOCKED).
 *        screenOrUnknown(ctx, input) — display-only checks (M31) get 'unknown' instead of an error.
 * M11    review type `sanctions.possible_match` (outcomes confirmed | cleared) and the
 *        `m17.file_possible_match` job. Call registerSanctionsModule() at boot (web and worker).
 */
export {
  DEFAULT_CLIENT_TIMEOUT_MS,
  RPC_PATH,
  SANCTIONS_RESULTS,
  SERVER_TIMEOUT_MS,
  assertSanctionsClear,
  configureSanctionsClient,
  resetSanctionsClientForTesting,
  screen,
  screenDetailed,
  screenOrUnknown,
} from './client.js';
export type { SanctionsClientConfig, SanctionsResult, SanctionsTransport, ScreenDetail, ScreenInput } from './client.js';
export {
  FILE_POSSIBLE_MATCH_JOB,
  POSSIBLE_MATCH_TYPE,
  RECORD_DECISION_JOB,
  SANCTIONS_OUTCOMES,
  filePossibleMatch,
  possibleMatchOutcomeSchema,
  possibleMatchPayloadSchema,
  registerSanctionsModule,
  resetSanctionsModuleForTesting,
} from './review.js';
export type { PossibleMatchOutcome, PossibleMatchPayload, SanctionsOutcome } from './review.js';
