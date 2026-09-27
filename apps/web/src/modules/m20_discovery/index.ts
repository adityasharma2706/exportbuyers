/**
 * M20 Web discovery path — serving-plane producer for on-demand discovery (IF-20a).
 *
 * The discovery pipeline itself runs in the knowledge plane (py/kp/m20_discovery). The serving
 * plane only enqueues `m20.discover` for cold (country × heading) cells and listens for EV-05
 * `discovery.completed {country, hsHeading, newCompanies, runId, degraded}`. Requests for the same
 * cell on the same UTC day share the idempotency key `disc:<heading>:<country>:<yyyy-mm-dd>`, so
 * concurrent on-demand requests are deduplicated.
 *
 * Mirrors py/kp/m20_discovery/models.py and jobs.py.
 */
import { enqueue } from '../m02_queue/index.js';
import type { Tx } from '../m02_queue/index.js';

export const DISCOVER_JOB = 'm20.discover';
export const EV_DISCOVERY_COMPLETED = 'discovery.completed';
export const SEARCH_RATE_CLASS = 'search_api';
export const DISCOVERY_QUEUE = 'knowledge' as const;
export const DISCOVERY_MAX_ATTEMPTS = 5;
/** Model version the knowledge plane tags every run's output with (HLD OQ9). */
export const DISCOVERY_V = 1;

export type DiscoveryReason = 'prewarm' | 'on_demand';

/** IF-20a job payload (camelCase on the wire). */
export interface DiscoverJobPayload {
  hsHeading: string;
  country: string;
  reason: DiscoveryReason;
  requestedBy?: string;
}

/** EV-05 payload. */
export interface DiscoveryCompletedEvent {
  country: string;
  hsHeading: string;
  newCompanies: number;
  runId: string;
  degraded: boolean;
  reason?: DiscoveryReason;
  requestedBy?: string;
  discoveryV?: number;
}

const HEADING_RE = /^\d{4}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DiscoveryRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryRequestError';
  }
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `disc:<heading>:<country>:<yyyy-mm-dd>` (UTC day). */
export function discoveryIdempotencyKey(hsHeading: string, country: string, now: Date = new Date()): string {
  return `disc:${hsHeading}:${country.toUpperCase()}:${utcDay(now)}`;
}

export function validateDiscoverPayload(input: {
  hsHeading: string;
  country: string;
  reason: DiscoveryReason;
  requestedBy?: string | null;
}): DiscoverJobPayload {
  const hsHeading = String(input.hsHeading).trim();
  const country = String(input.country).trim().toUpperCase();
  if (!HEADING_RE.test(hsHeading)) throw new DiscoveryRequestError('hsHeading must be a 4-digit HS heading');
  if (!COUNTRY_RE.test(country)) throw new DiscoveryRequestError('country must be an ISO 3166-1 alpha-2 code');
  if (input.reason !== 'prewarm' && input.reason !== 'on_demand') {
    throw new DiscoveryRequestError("reason must be 'prewarm' or 'on_demand'");
  }
  const out: DiscoverJobPayload = { hsHeading, country, reason: input.reason };
  if (input.requestedBy) {
    if (!UUID_RE.test(input.requestedBy)) throw new DiscoveryRequestError('requestedBy must be an account uuid');
    out.requestedBy = input.requestedBy;
  }
  return out;
}

/**
 * Enqueues an on-demand discovery job for a cold cell inside the caller's transaction and returns
 * the (new or existing) job id. Completion arrives as EV-05 `discovery.completed`.
 */
export async function requestDiscovery(
  tx: Tx,
  args: { hsHeading: string; country: string; requestedBy?: string | null; now?: Date },
  ctx?: Parameters<typeof enqueue>[2],
): Promise<Awaited<ReturnType<typeof enqueue>>> {
  const payload = validateDiscoverPayload({
    hsHeading: args.hsHeading,
    country: args.country,
    reason: 'on_demand',
    requestedBy: args.requestedBy ?? null,
  });
  return enqueue(
    tx,
    {
      type: DISCOVER_JOB,
      queue: DISCOVERY_QUEUE,
      payload,
      idempotencyKey: discoveryIdempotencyKey(payload.hsHeading, payload.country, args.now ?? new Date()),
      rateClass: SEARCH_RATE_CLASS,
      maxAttempts: DISCOVERY_MAX_ATTEMPTS,
    },
    ctx,
  );
}

/** Narrowing guard for EV-05 payloads received by serving-plane subscribers. */
export function isDiscoveryCompleted(p: unknown): p is DiscoveryCompletedEvent {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.country === 'string' &&
    COUNTRY_RE.test(o.country) &&
    typeof o.hsHeading === 'string' &&
    HEADING_RE.test(o.hsHeading) &&
    typeof o.newCompanies === 'number' &&
    Number.isInteger(o.newCompanies) &&
    o.newCompanies >= 0 &&
    typeof o.runId === 'string' &&
    typeof o.degraded === 'boolean'
  );
}
