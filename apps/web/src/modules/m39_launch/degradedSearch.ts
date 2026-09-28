/**
 * M39 — "search API down" degraded mode (LLD M39 #4: "Search API down -> 'finding more' becomes
 * 'try later'.").
 *
 * M20's discovery pipeline already reports `degraded: true` on EV-05 `discovery.completed` when
 * the run itself could not reach its web-search vendor (py/kp/m20_discovery). M26 (buyer search)
 * was built before this module and does not expose that flag on its own `discovery` status map
 * (its `DiscoveryState` union is only `'idle'|'running'|'done'`), and per the pipeline's rule
 * against rewriting an earlier module's files this module does not add a state to that union.
 * Instead it tracks a short-lived per-(heading,country) "recently degraded" flag from EV-05 and
 * exposes it alongside M26's own status, so a caller can turn a 'running' "finding more…" banner
 * into "try later" without M26 needing to know this module exists.
 */
import { getRedis, log } from '../m01_platform/index.js';
import { isDiscoveryCompleted, EV_DISCOVERY_COMPLETED, type DiscoveryCompletedEvent } from '../m20_discovery/index.js';
import { registerEventSchema, subscribe, type EventMeta } from '../m02_queue/index.js';
import { z } from 'zod';
import type { DiscoveryState } from '../m26_buyer_search/index.js';
import { discoveryStatus } from '../m26_buyer_search/index.js';

/** How long a degraded discovery run keeps the country flagged "try later" for. [tunable] */
export const DEGRADED_FLAG_TTL_SEC = 30 * 60;

function degradedFlagKey(heading: string, country: string): string {
  return `m39:discovery:degraded:${heading}:${country.toUpperCase()}`;
}

/** EV-05 handler: marks or clears the (heading, country) cell as recently degraded. */
export async function onDiscoveryCompleted(payload: DiscoveryCompletedEvent): Promise<void> {
  const redis = getRedis();
  const key = degradedFlagKey(payload.hsHeading, payload.country);
  if (payload.degraded) {
    await redis.set(key, '1', 'EX', DEGRADED_FLAG_TTL_SEC);
    log.warn({ heading: payload.hsHeading, country: payload.country, runId: payload.runId }, 'm39: discovery run degraded; flagging "try later"');
  } else {
    await redis.del(key);
  }
}

/** Reads the current degraded flags for a set of countries under one heading. */
export async function searchDownFlags(heading: string, countries: readonly string[]): Promise<Record<string, boolean>> {
  const redis = getRedis();
  const out: Record<string, boolean> = {};
  await Promise.all(
    countries.map(async (country) => {
      out[country] = (await redis.get(degradedFlagKey(heading, country))) !== null;
    }),
  );
  return out;
}

export interface DiscoveryStatusWithDownDto {
  state: DiscoveryState;
  /** True when the most recent discovery run for this cell could not reach its search vendor. */
  searchDown: boolean;
}

/** M26's own `discoveryStatus`, enriched with the "try later" flag per country. */
export async function discoveryStatusDetailed(heading: string, countries: readonly string[]): Promise<Record<string, DiscoveryStatusWithDownDto>> {
  const [states, down] = await Promise.all([discoveryStatus(heading, countries), searchDownFlags(heading, countries)]);
  const out: Record<string, DiscoveryStatusWithDownDto> = {};
  for (const country of countries) {
    out[country] = { state: states[country] ?? 'idle', searchDown: down[country] ?? false };
  }
  return out;
}

const discoveryCompletedSchema = z.object({
  country: z.string(),
  hsHeading: z.string(),
  newCompanies: z.number(),
  runId: z.string(),
  degraded: z.boolean(),
  reason: z.enum(['prewarm', 'on_demand']).optional(),
  requestedBy: z.string().optional(),
  discoveryV: z.number().optional(),
});

let registered = false;

/** Wires the EV-05 subscription. Idempotent; call once at boot (web and worker). */
export function registerDegradedSearchWatch(): void {
  if (registered) return;
  registerEventSchema(EV_DISCOVERY_COMPLETED, discoveryCompletedSchema);
  subscribe(EV_DISCOVERY_COMPLETED, 'm39.degraded_search_flag', async (payload: unknown, _meta: EventMeta) => {
    if (!isDiscoveryCompleted(payload)) {
      log.warn({ payload }, 'm39: discovery.completed payload failed narrowing; skipping');
      return;
    }
    await onDiscoveryCompleted(payload);
  });
  registered = true;
}

/** For tests. */
export function resetDegradedSearchWatchForTesting(): void {
  registered = false;
}

/**
 * [deviation: EV-05 `discovery.completed` is emitted by the Python knowledge plane directly into
 * the shared `platform.outbox` table (M20's own header comment: "handled by the knowledge
 * plane"), and neither M20 nor M15 (its other documented consumer) declares this event in M02's
 * `EventRegistry`, so `subscribe()` has no typed payload for it yet. This module is the first TS
 * subscriber, so it adds the augmentation here, matching M20's own `DiscoveryCompletedEvent`
 * shape exactly.]
 */
declare module '../m02_queue/types.js' {
  interface EventRegistry {
    'discovery.completed': DiscoveryCompletedEvent;
  }
}
