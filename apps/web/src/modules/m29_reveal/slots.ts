/**
 * M29 — pure contact-slot resolution (LLD M29 sequence step 5): merges a profile doc's contact
 * slots with re-verification outcomes into per-slot deliverability/staleness, without touching the
 * database or network. Kept separate from service.ts so it is unit-testable without a DB or RPC.
 */
import { CONTACT_STALE_DAYS } from './config.js';
import type { ProfileContactSlot, SlotResolution } from './types.js';
import type { VerifyOutcome } from './reverify.js';

/** True when `checkedAt` is missing or older than `staleDays`. */
export function isStale(checkedAt: string | null, now: Date, staleDays: number = CONTACT_STALE_DAYS): boolean {
  if (!checkedAt) return true;
  const ms = Date.parse(checkedAt);
  if (Number.isNaN(ms)) return true;
  return ms < now.getTime() - staleDays * 24 * 3600 * 1000;
}

/** Splits a profile doc's contact slots into those fresh enough to trust as-is and those that
 * need a re-verify RPC call (LLD M29: "Slots with checked_at older than 90 days → reverify RPC"). */
export function splitByStaleness(
  slots: readonly ProfileContactSlot[],
  now: Date,
  staleDays: number = CONTACT_STALE_DAYS,
): { fresh: ProfileContactSlot[]; stale: ProfileContactSlot[] } {
  const fresh: ProfileContactSlot[] = [];
  const stale: ProfileContactSlot[] = [];
  for (const s of slots) (isStale(s.checked_at, now, staleDays) ? stale : fresh).push(s);
  return { fresh, stale };
}

/**
 * Resolves every slot (fresh + stale) to a final deliverability/staleness. `outcomes` must have
 * one entry per stale slot's assertion id (reverify()'s contract: every requested id gets an
 * answer). LLD M29 outcomes:
 *   - invalid → still returned here (deliverability 'invalid'); callers filter it out.
 *   - unknown / timeout → included with stale:true, deliverability 'unknown'.
 *   - fresh slots (not sent to reverify) keep the profile doc's own deliverability, stale:false.
 *   - valid/risky from a reverify call are fresh re-checks, so stale:false.
 */
export function resolveSlots(
  slots: readonly ProfileContactSlot[],
  outcomes: ReadonlyMap<string, VerifyOutcome>,
  now: Date,
  staleDays: number = CONTACT_STALE_DAYS,
): SlotResolution[] {
  const out: SlotResolution[] = [];
  for (const s of slots) {
    if (isStale(s.checked_at, now, staleDays)) {
      const outcome = outcomes.get(s.assertion_id);
      if (outcome) {
        out.push({
          assertionId: s.assertion_id,
          kind: s.kind,
          deliverability: outcome.status,
          checkedAt: outcome.checkedAt,
          stale: outcome.status === 'unknown',
        });
      } else {
        // reverify() always answers every id it was given; this is a defensive fallback only.
        out.push({ assertionId: s.assertion_id, kind: s.kind, deliverability: 'unknown', checkedAt: now, stale: true });
      }
    } else {
      const parsed = s.checked_at ? new Date(s.checked_at) : now;
      const deliverability = s.deliverability === 'valid' || s.deliverability === 'risky' || s.deliverability === 'invalid'
        ? s.deliverability
        : 'unknown';
      out.push({
        assertionId: s.assertion_id,
        kind: s.kind,
        deliverability,
        checkedAt: Number.isNaN(parsed.getTime()) ? now : parsed,
        stale: false,
      });
    }
  }
  return out;
}

/** LLD M29 step 5: "invalid → excluded." */
export function excludeInvalid(rows: readonly SlotResolution[]): SlotResolution[] {
  return rows.filter((r) => r.deliverability !== 'invalid');
}
