/**
 * M43 — the actor used for every write this module makes on an account's behalf outside the
 * filing request itself: the `billing.money_back` outcome handler's M36 subscription cancel and
 * M28 ledger adjustment. Mirrors M28's own inline SYSTEM_CTX and M30/M38/M41's systemCtx.ts (same
 * shape, same reasoning: M28's `grant()` only checks `ctx.kind`, and M36's `cancelSubscription`
 * only checks `ctx.accountId`, so one context with both set covers both calls).
 */
import type { ActorContext, Id } from '../m01_platform/index.js';

export function systemCtxFor(accountId: string, correlationId = 'm43-system'): ActorContext {
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
