/**
 * M38 — the actor used for every write/read M38 makes on an account's behalf outside a user
 * request (the export/erase background jobs; the EV-11 ConsentWithdrawn subscriber). Mirrors
 * M30's own systemCtx.ts (same shape, same reasoning: several contributor calls — M28's
 * `balance`/`usageHistory`, M36's `cancelSubscription`/`listInvoices` — go through `userExec(ctx)`,
 * which only requires `ctx.accountId` to be set, not a real signed-in member).
 */
import type { ActorContext, Id } from '../m01_platform/index.js';

export function systemCtxFor(accountId: string, correlationId = 'm38-system'): ActorContext {
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
