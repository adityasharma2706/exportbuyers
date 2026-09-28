/**
 * M29 Contact reveal — public API. Other modules import ONLY from this file.
 * REQ-032, REQ-033, REQ-034, REQ-029 (blocked reveal), REQ-054.
 *
 * IF-29a  POST /api/reveal, POST /api/reveal/bulk, GET /api/reveal/bulk/:id
 * IF-29b  revealedContacts(ctx, companyIds?) — decrypted, for M35's export job
 * Jobs    m29.reveal_bulk — large bulk-reveal batches (LLD M29 Bulk)
 *
 * Call `registerRevealModule()` once at boot (web and worker), after M27 and M02 have loaded:
 * it registers this module as M27's `revealed` provider and registers the bulk-reveal job.
 */
import { registerProvider as registerBuyerProfileProvider } from '../m27_buyer_profile/index.js';
import { registerRevealJobs } from './jobs.js';
import { isRevealed } from './service.js';

export type {
  BulkJobPayload,
  BulkRevealResponseDto,
  ContactKind,
  Deliverability,
  NoValidContactsResponseDto,
  ProfileContactSlot,
  ResolvedContact,
  RevealApiResponse,
  RevealBulkItem,
  RevealBulkItemStatus,
  RevealBulkRow,
  RevealBulkState,
  RevealContactRow,
  RevealResponseDto,
  RevealRow,
  RevealState,
  RevealedContact,
  RevealedContactDto,
  SlotResolution,
} from './types.js';
export { CONTACT_KINDS, DELIVERABILITY_STATUSES } from './types.js';

export { encryptValue, decryptValue } from './crypto.js';

export {
  getBulkReveal,
  isRevealed,
  resolveContactsForCompany,
  reveal,
  revealBulk,
  revealedContacts,
  runBulkBatch,
} from './service.js';

export { registerRevealJobs, resetRevealJobsForTesting } from './jobs.js';

export { registerRevealRoutes } from './routes.js';
export type { RevealRouteApp, RevealRouteReply, RevealRouteRequest } from './routes.js';

export {
  configureReverifyClient,
  resetReverifyClientForTesting,
  reverify,
  type ReverifyClientConfig,
  type ReverifyTransport,
  type ReverifyTrigger,
  type VerifyOutcome,
} from './reverify.js';

export { fetchContactValues, closeContactValuePool, resetContactValuePoolForTesting, type ContactValueRow } from './contactValues.js';

export { excludeInvalid, isStale, resolveSlots, splitByStaleness } from './slots.js';

export { CONTACT_STALE_DAYS, INLINE_BULK_MAX, BULK_CONCURRENCY, BULK_JOB_TYPE } from './config.js';

let registered = false;

/**
 * Wires M29 into the rest of the system: registers this module as M27's `revealed` provider
 * (LLD M27 providers.ts: "False (never revealed) until M29 registers") and registers the
 * bulk-reveal job handler with M02. Idempotent; call once at boot in both the web process and the
 * worker process (the worker needs the job handler, the web process needs the provider).
 */
export function registerRevealModule(): void {
  if (registered) return;
  registerBuyerProfileProvider('revealed', { isRevealed });
  registerRevealJobs();
  registered = true;
}

/** For tests. */
export function resetRevealModuleForTesting(): void {
  registered = false;
}
