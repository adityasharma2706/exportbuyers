/**
 * M38 — IF-38a `registerContributor`. Every module that stores anything tied to an `account_id`
 * registers one contributor here; M38's export/erase jobs (exportJob.ts / eraseJob.ts) run them
 * without knowing anything about the modules themselves.
 *
 * Re-registering the same `module` name replaces the previous registration (idempotent — a
 * module's file may run its own registration call more than once, e.g. in tests, or across a
 * hot-reloaded boot sequence).
 *
 * [deviation: the LLD's contributor order example is "M34 drafts, M33, M29 reveals, M32, M35,
 * M30, M41…, then M07, M06 last". M38's declared dependencies (docs/implementer.md) are only
 * M02, M06, M07, M28, M33, M34, M36 — M29 (reveals), M30 (reports/hides), M32 (check-a-buyer)
 * and M35 (exports) are not, even though all four already exist in this workspace and hold
 * account-linked data (encrypted contact reveals, report notes, check inputs, generated export
 * files). Because they are not declared dependencies, this module does not import them or erase/
 * export their rows; ORDER below reserves their LLD-implied slots so a follow-up change to those
 * modules (each calling registerContributor() from its own index.ts, the same way this file does
 * for M05..M36) closes that gap without reordering anything already registered. Until then, an
 * account's reveal/report/check/export history rows remain, referencing the (now permanently
 * `deleted`) account row — the LLD's own retention list is the model for this: some
 * account-linked data can outlive erasure by design; here it does so as a known gap, not a
 * design choice, and is recorded as such.]
 */
import { AppError } from '../m01_platform/index.js';
import type { DataRightsContributor } from './types.js';

/** Registration order (LLD Rules step 2). Gaps reserve slots for modules not yet wired in — see
 * the deviation note above. */
export const CONTRIBUTOR_ORDER = Object.freeze({
  M34_DRAFTS: 10,
  M33_PIPELINE: 20,
  M29_REVEALS: 30, // reserved: M29 is not a declared M38 dependency (see module doc comment)
  M32_CHECK: 40, // reserved: M32 is not a declared M38 dependency
  M35_EXPORTS: 50, // reserved: M35 is not a declared M38 dependency
  M30_REPORTS: 60, // reserved: M30 is not a declared M38 dependency
  M41_REMINDERS: 70, // reserved: M41 does not exist yet
  M28_CREDITS: 75,
  M36_BILLING: 80,
  M05_IDENTITY: 90,
  M07_TENANCY: 95,
  M06_CONSENT: 100, // LLD: "M06 last"
});

const contributors = new Map<string, DataRightsContributor>();

/** IF-38a. */
export function registerContributor(c: DataRightsContributor): void {
  if (typeof c.module !== 'string' || c.module.trim().length === 0) {
    throw new AppError('VALIDATION', 'registerContributor: module name is required');
  }
  if (typeof c.export !== 'function' || typeof c.erase !== 'function') {
    throw new AppError('VALIDATION', `registerContributor(${c.module}): export/erase must be functions`);
  }
  if (!Number.isFinite(c.order)) {
    throw new AppError('VALIDATION', `registerContributor(${c.module}): order must be a finite number`);
  }
  contributors.set(c.module, c);
}

/** Every registered contributor, ordered ascending by `order` (ties broken by module name so the
 * order is deterministic). */
export function listContributorsOrdered(): DataRightsContributor[] {
  return [...contributors.values()].sort((a, b) => (a.order - b.order) || a.module.localeCompare(b.module));
}

export function registeredContributorModules(): string[] {
  return [...contributors.keys()].sort();
}

/** For tests. */
export function resetDataRightsRegistryForTesting(): void {
  contributors.clear();
}
