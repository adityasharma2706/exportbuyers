/**
 * M40 — pure decision rule (LLD M40 EV-12 handler):
 *   "1:1 with the same code -> update silently and log it. Otherwise -> hs_needs_reconfirm=true."
 *
 * No candidates, several candidates, or a 1:1 match to a *different* code all need the user's
 * re-confirmation; only an exact 1:1 self-match is safe to carry over automatically.
 */
import type { HsCorrelationResult } from '../m12_hs/index.js';

export type ReconfirmDecision = 'silent_update' | 'flag';

export function decideOutcome(oldCode: string, candidates: readonly HsCorrelationResult[]): ReconfirmDecision {
  if (candidates.length === 1 && candidates[0]!.relation === '1:1' && candidates[0]!.code === oldCode) {
    return 'silent_update';
  }
  return 'flag';
}
