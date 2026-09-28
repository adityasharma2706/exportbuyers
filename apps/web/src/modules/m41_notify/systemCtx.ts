/**
 * M41 — the actor used for every write/read this module makes on an account's behalf outside a
 * signed-in request: `notify()` (IF-41b, called with a bare `accountId` by M02 events, the
 * scheduler and other modules, never an ActorContext) and the `m41.fire_reminders` scheduler job.
 * Mirrors M28's own inline SYSTEM_CTX and M38/M30's systemCtx.ts (same shape, same reasoning).
 */
import type { ActorContext, Id } from '../m01_platform/index.js';

export function systemCtxFor(accountId: string, correlationId = 'm41-system'): ActorContext {
  return {
    kind: 'system',
    accountId: accountId as Id<'account'>,
    entitlements: { plan: 'anonymous', searchResultCap: 0, exportRowsPerMonth: 0, bulkRevealMax: 0, checksPerMonth: 0, revealsIncludedPerMonth: 0 },
    locale: 'en',
    region: 'IN',
    mfaVerified: false,
    correlationId,
  };
}
