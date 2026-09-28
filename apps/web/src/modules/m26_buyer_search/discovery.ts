/**
 * M26 — the "finding more buyers…" state (LLD M26 rule: "Discovery trigger: for each country
 * where total_in_country < 10 and coverage.label != 'strong' → enqueue IF-20a on_demand. Status
 * is read from the platform.job state for that idempotency key.").
 *
 * `platform.job` is M02's table; there is no IF-02 read primitive for "status of the job with
 * this idempotency key" (M02's public API only exposes the producer/worker paths), so this reads
 * it directly through `systemDb()`, the same pattern M15's coverage repo and M10's suppression
 * lookup use for read-only reference data outside their own module.
 */
import { sql } from 'kysely';
import { log, systemDb } from '../m01_platform/index.js';
import { discoveryIdempotencyKey, requestDiscovery, DISCOVER_JOB } from '../m20_discovery/index.js';
import type { CoverageCell } from '../m15_coverage/index.js';
import type { DiscoveryState } from './types.js';

/** LLD M26: `total_in_country < 10 and coverage.label != 'strong'`.
 *
 * `total_in_country` is approximated with M15's `companyCount` for (country, heading) rather than
 * a fresh per-country IF-10a search count [deviation: the LLD does not specify which filters
 * `total_in_country` respects; recomputing it exactly would mean one extra IF-10a search call per
 * requested country on every search request. `companyCount` is already fetched for the coverage
 * label shown on the same row, so this reuses it instead of the more expensive exact count].
 */
export function countriesNeedingDiscovery(cells: ReadonlyMap<string, CoverageCell>, minCompanies: number): string[] {
  const out: string[] = [];
  for (const [country, cell] of cells) {
    if (cell.companyCount < minCompanies && cell.label !== 'strong') out.push(country);
  }
  return out;
}

/** Best-effort: a queue outage must not fail the search response. */
export async function triggerDiscoveryForCountries(
  heading: string,
  countries: readonly string[],
  requestedBy: string | null,
): Promise<void> {
  await Promise.all(
    countries.map(async (country) => {
      try {
        await requestDiscovery(systemDb('m26 on-demand discovery trigger'), {
          hsHeading: heading,
          country,
          requestedBy: requestedBy ?? undefined,
        });
      } catch (err) {
        log.warn({ err, heading, country }, 'm26: could not enqueue on-demand discovery');
      }
    }),
  );
}

const RUNNING_STATES = new Set(['queued', 'running']);
const FINISHED_STATES = new Set(['done', 'dead', 'failed']);

/** Reads job state for each country's `disc:<heading>:<country>:<yyyy-mm-dd>` idempotency key. */
export async function discoveryStatusForCountries(
  heading: string,
  countries: readonly string[],
  now: Date = new Date(),
): Promise<Record<string, DiscoveryState>> {
  const out: Record<string, DiscoveryState> = {};
  if (countries.length === 0) return out;
  const keys = countries.map((c) => discoveryIdempotencyKey(heading, c, now));
  const res = await sql<{ idempotency_key: string; state: string }>`
    select idempotency_key, state
      from platform.job
     where type = ${DISCOVER_JOB}
       and idempotency_key = any(${keys}::text[])`.execute(systemDb('m26 discovery status read'));
  const byKey = new Map(res.rows.map((r) => [r.idempotency_key, r.state]));
  countries.forEach((country, i) => {
    const state = byKey.get(keys[i]!);
    out[country] = state === undefined ? 'idle' : RUNNING_STATES.has(state) ? 'running' : FINISHED_STATES.has(state) ? 'done' : 'idle';
  });
  return out;
}
