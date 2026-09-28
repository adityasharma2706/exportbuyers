/**
 * M44 — the actor used to read a company's profile doc (country, hs_headings) through M10's
 * policy layer from inside the EV-08 event handler, which runs with a bare account id, never a
 * signed-in ActorContext. Mirrors M41/M38/M30/M43's own inline systemCtx.ts (same shape, same
 * reasoning): a background job has no signed-in actor, but M10's suppression/sanctions/hidden
 * rules must still be evaluated before anything is written.
 */
import type { ActorContext, Id } from '../m01_platform/index.js';

export function systemCtxFor(accountId: string, correlationId = 'm44-system'): ActorContext {
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
