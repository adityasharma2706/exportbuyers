/**
 * M04 — performance budgets for mid-range Android on 4G (REQ-057).
 *
 * CI runs Lighthouse with the Moto G Power mobile profile and simulated slow-4G throttling
 * (apps/web/lighthouserc.json) and fails the build on any breach. The same numbers live here so
 * the route-bundle check and the Lighthouse assertions cannot drift apart.
 */

export const PERFORMANCE_BUDGETS = {
  /** Largest Contentful Paint, milliseconds. */
  lcpMs: 2_500,
  /** First-load JavaScript per route, gzipped bytes (170 KB). */
  jsGzipBytesPerRoute: 170 * 1024,
  /** Cumulative Layout Shift, unitless. */
  cls: 0.1,
} as const;

/** Lighthouse mobile emulation matching the Moto G Power profile over slow 4G. */
export const LIGHTHOUSE_DEVICE_PROFILE = {
  formFactor: 'mobile',
  screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
  throttlingMethod: 'simulate',
  throttling: {
    rttMs: 150,
    throughputKbps: 1_638.4,
    requestLatencyMs: 562.5,
    downloadThroughputKbps: 1_474.56,
    uploadThroughputKbps: 675,
    cpuSlowdownMultiplier: 4,
  },
} as const;

export interface BudgetBreach {
  metric: 'lcp' | 'js' | 'cls';
  route: string;
  actual: number;
  limit: number;
}

export interface LighthouseMetrics {
  route: string;
  lcpMs: number;
  cls: number;
  /** Transfer size of all script resources (gzipped over the wire). */
  scriptTransferBytes: number;
}

/** Checks one route's Lighthouse metrics against the budgets. */
export function evaluateLighthouse(metrics: LighthouseMetrics): BudgetBreach[] {
  const breaches: BudgetBreach[] = [];
  if (!(metrics.lcpMs <= PERFORMANCE_BUDGETS.lcpMs)) {
    breaches.push({ metric: 'lcp', route: metrics.route, actual: metrics.lcpMs, limit: PERFORMANCE_BUDGETS.lcpMs });
  }
  if (!(metrics.cls <= PERFORMANCE_BUDGETS.cls)) {
    breaches.push({ metric: 'cls', route: metrics.route, actual: metrics.cls, limit: PERFORMANCE_BUDGETS.cls });
  }
  if (!(metrics.scriptTransferBytes <= PERFORMANCE_BUDGETS.jsGzipBytesPerRoute)) {
    breaches.push({
      metric: 'js',
      route: metrics.route,
      actual: metrics.scriptTransferBytes,
      limit: PERFORMANCE_BUDGETS.jsGzipBytesPerRoute,
    });
  }
  return breaches;
}

/**
 * Checks gzipped first-load JS per route (e.g. computed from the Next.js build manifest by the
 * CI step). Every route is checked, so a new page cannot slip in over budget.
 */
export function evaluateRouteBundles(gzipBytesByRoute: Readonly<Record<string, number>>): BudgetBreach[] {
  const breaches: BudgetBreach[] = [];
  for (const [route, bytes] of Object.entries(gzipBytesByRoute)) {
    if (!Number.isFinite(bytes) || bytes > PERFORMANCE_BUDGETS.jsGzipBytesPerRoute) {
      breaches.push({ metric: 'js', route, actual: bytes, limit: PERFORMANCE_BUDGETS.jsGzipBytesPerRoute });
    }
  }
  return breaches;
}

export function formatBreach(breach: BudgetBreach): string {
  const unit = breach.metric === 'lcp' ? ' ms' : breach.metric === 'js' ? ' bytes (gzip)' : '';
  return `${breach.route}: ${breach.metric.toUpperCase()} ${breach.actual}${unit} exceeds budget ${breach.limit}${unit}`;
}
