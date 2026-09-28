/**
 * M43 — module wiring: registers the `billing.money_back` review type (M11) and the requester
 * notification job (M02).
 *
 * Call registerMoneyBackModule() once at boot (web and worker), after M11, M28 and M36 have
 * loaded, and before M02's syncRegistrations().
 */
import { registerMoneyBackReviewType } from './reviewType.js';
import { registerNotifyJob } from './notify.js';

let registered = false;

export function registerMoneyBackModule(): void {
  if (registered) return;
  registerMoneyBackReviewType();
  registerNotifyJob();
  registered = true;
}

/** Test hook. */
export function resetMoneyBackModuleForTesting(): void {
  registered = false;
}
