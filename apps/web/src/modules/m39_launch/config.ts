/**
 * M39 — tunables (LLD M39 "Deliverables" 3, 5, 6). Values marked [tunable] in the LLD live here
 * as defaults and can be overridden through environment variables, the same pattern M05/M35 use.
 */
import { AppError } from '../m01_platform/index.js';

export interface LaunchHardeningConfig {
  antiScrape: {
    /** LLD M39 #3: "Per-account search pages capped at 200/day on Free and 2000/day on paid". */
    dailySearchPageCap: { free: number; paid: number };
    /** LLD M39 #3: "Sequential-page velocity detection (more than 30 pages in 5 minutes)". */
    velocity: { windowSec: number; threshold: number };
    /** How long a passed challenge is honoured for one account, mirroring M05's anon guard. */
    challengePassTtlSec: number;
  };
  exportCanaryWatch: {
    /** How far back (days) to consider an export's canary "active" and worth searching for. */
    lookbackDays: number;
    /** Max canaries checked per monthly run (keeps one vendor outage from stalling the job). */
    maxCanariesPerRun: number;
  };
  costPerCredit: {
    /** Default report window when none is given (days). */
    defaultWindowDays: number;
  };
  activation: {
    /** LLD M39 #6: "Activation-metric instrumentation (>=5 saved, >=1 draft)". */
    savedThreshold: number;
    draftedThreshold: number;
  };
}

const DEFAULTS: LaunchHardeningConfig = Object.freeze({
  antiScrape: Object.freeze({
    dailySearchPageCap: Object.freeze({ free: 200, paid: 2000 }),
    velocity: Object.freeze({ windowSec: 5 * 60, threshold: 30 }),
    challengePassTtlSec: 3600,
  }),
  exportCanaryWatch: Object.freeze({
    lookbackDays: 90,
    maxCanariesPerRun: 500,
  }),
  costPerCredit: Object.freeze({
    defaultWindowDays: 30,
  }),
  activation: Object.freeze({
    savedThreshold: 5,
    draftedThreshold: 1,
  }),
}) as LaunchHardeningConfig;

function positiveInt(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AppError('VALIDATION', `Config value "${v}" must be a positive integer`);
  }
  return n;
}

let current: LaunchHardeningConfig = DEFAULTS;

export function loadLaunchHardeningConfig(env: Record<string, string | undefined> = process.env): LaunchHardeningConfig {
  current = {
    antiScrape: {
      dailySearchPageCap: {
        free: positiveInt(env.M39_SEARCH_PAGE_CAP_FREE, DEFAULTS.antiScrape.dailySearchPageCap.free),
        paid: positiveInt(env.M39_SEARCH_PAGE_CAP_PAID, DEFAULTS.antiScrape.dailySearchPageCap.paid),
      },
      velocity: {
        windowSec: positiveInt(env.M39_VELOCITY_WINDOW_SEC, DEFAULTS.antiScrape.velocity.windowSec),
        threshold: positiveInt(env.M39_VELOCITY_THRESHOLD, DEFAULTS.antiScrape.velocity.threshold),
      },
      challengePassTtlSec: positiveInt(env.M39_CHALLENGE_PASS_TTL_SEC, DEFAULTS.antiScrape.challengePassTtlSec),
    },
    exportCanaryWatch: {
      lookbackDays: positiveInt(env.M39_CANARY_LOOKBACK_DAYS, DEFAULTS.exportCanaryWatch.lookbackDays),
      maxCanariesPerRun: positiveInt(env.M39_CANARY_MAX_PER_RUN, DEFAULTS.exportCanaryWatch.maxCanariesPerRun),
    },
    costPerCredit: {
      defaultWindowDays: positiveInt(env.M39_COST_PER_CREDIT_WINDOW_DAYS, DEFAULTS.costPerCredit.defaultWindowDays),
    },
    activation: {
      savedThreshold: positiveInt(env.M39_ACTIVATION_SAVED_THRESHOLD, DEFAULTS.activation.savedThreshold),
      draftedThreshold: positiveInt(env.M39_ACTIVATION_DRAFTED_THRESHOLD, DEFAULTS.activation.draftedThreshold),
    },
  };
  return current;
}

export function launchHardeningConfig(): LaunchHardeningConfig {
  return current;
}

/** For tests. */
export function setLaunchHardeningConfig(patch: Partial<LaunchHardeningConfig>): void {
  current = {
    antiScrape: { ...current.antiScrape, ...(patch.antiScrape ?? {}) },
    exportCanaryWatch: { ...current.exportCanaryWatch, ...(patch.exportCanaryWatch ?? {}) },
    costPerCredit: { ...current.costPerCredit, ...(patch.costPerCredit ?? {}) },
    activation: { ...current.activation, ...(patch.activation ?? {}) },
  };
}
