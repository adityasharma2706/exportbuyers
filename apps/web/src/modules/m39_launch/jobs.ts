/**
 * M39 — boot wiring. Call `registerLaunchHardeningModule()` once at boot (web and worker),
 * after M02, M20, M26, M33, M34 and M35 have loaded, mirroring every other module's own
 * `register<Name>Module()` entry point (M30, M32, M35, M36...).
 */
import { registerActivationTracking } from './activation.js';
import { loadLaunchHardeningConfig } from './config.js';
import { registerDegradedSearchWatch } from './degradedSearch.js';
import { registerExportCanaryWatchJob } from './exportCanaryWatch.js';

let registered = false;

export function registerLaunchHardeningModule(): void {
  if (registered) return;
  loadLaunchHardeningConfig();
  registerDegradedSearchWatch();
  registerExportCanaryWatchJob();
  registerActivationTracking();
  registered = true;
}

/** For tests. */
export function resetLaunchHardeningModuleForTesting(): void {
  registered = false;
}
