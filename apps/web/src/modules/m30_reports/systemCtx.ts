/**
 * M30 — the actor used for every write M30 makes on an account's behalf outside a user request:
 * the EV-06 (ContactInvalidated/ContactVerified) handlers, the reverify-timeout sweep, and the
 * `report.refund_exception` outcome handler's approved refund. Mirrors M28's own
 * `jobs.ts#SYSTEM_CTX` (same shape, same reasoning: M28's `refund()` accepts a system/admin actor
 * without requiring the acting account to match the credited account).
 */
import type { ActorContext } from '../m01_platform/index.js';

export const SYSTEM_CTX: ActorContext = {
  kind: 'system',
  entitlements: { plan: 'anonymous', searchResultCap: 0, exportRowsPerMonth: 0, bulkRevealMax: 0, checksPerMonth: 0, revealsIncludedPerMonth: 0 },
  locale: 'en',
  region: 'IN',
  mfaVerified: false,
  correlationId: 'm30-system',
};
