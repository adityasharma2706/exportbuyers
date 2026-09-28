/**
 * M29 — TS client for IF-25a's synchronous re-verification RPC (py/kp/m25_freshness/rpc.py):
 *
 *   POST {KP_RPC_BASE_URL}/rpc/reverify  {assertionIds, trigger, triggerRef}
 *     → 200 {outcomes: [{assertionId, status, checkedAt}]}
 *
 * The server already enforces its own wait budget (`REVERIFY_RPC_WAIT_MS`, LLD M25: "it waits up
 * to reverify_rpc_wait_ms. Anything still pending comes back as unknown while the job continues in
 * the background."), so this client's timeout only needs to cover the network hop on top of that.
 *
 * Mirrors M17's client.ts shape (injectable transport, configureX/resetX-for-testing) but the
 * failure behaviour is different — see `reverify()`.
 */
import { AppError, getSecret, hasSecret, log, type ActorContext } from '../m01_platform/index.js';
import { REVERIFY_MAX_IDS } from './config.js';
import type { Deliverability } from './types.js';

export type ReverifyTrigger = 'reveal' | 'report' | 'schedule';

export interface VerifyOutcome {
  assertionId: string;
  status: Deliverability;
  checkedAt: Date;
}

export type ReverifyTransport = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface ReverifyClientConfig {
  baseUrl: string;
  token: () => string;
  timeoutMs: number;
  transport: ReverifyTransport;
}

export const RPC_PATH = '/rpc/reverify';
/** Server budget (~12 s, LLD M25 `REVERIFY_RPC_WAIT_MS`) + network allowance. [tunable] */
export const DEFAULT_CLIENT_TIMEOUT_MS = 13_000;

const defaultTransport: ReverifyTransport = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

function loadClientConfig(env: NodeJS.ProcessEnv = process.env): ReverifyClientConfig {
  const appEnv = env.APP_ENV ?? 'local';
  let baseUrl = env.KP_RPC_BASE_URL ?? '';
  if (!baseUrl) {
    if (appEnv === 'local' || appEnv === 'test') baseUrl = 'http://127.0.0.1:8081';
    else throw new AppError('INTERNAL', `KP_RPC_BASE_URL is required in ${appEnv}`);
  }
  const rawTimeout = env.M29_REVERIFY_TIMEOUT_MS;
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_CLIENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new AppError('VALIDATION', 'M29_REVERIFY_TIMEOUT_MS must be an integer in [100, 30000]');
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    token: () => {
      if (!hasSecret('KP_RPC_TOKEN')) throw new AppError('INTERNAL', 'Secret KP_RPC_TOKEN is not configured');
      return getSecret('KP_RPC_TOKEN');
    },
    timeoutMs,
    transport: defaultTransport,
  };
}

let config: ReverifyClientConfig | undefined;

export function configureReverifyClient(over?: Partial<ReverifyClientConfig>): ReverifyClientConfig {
  const base = over && config ? config : loadClientConfig();
  config = { ...base, ...(over ?? {}) };
  return config;
}

export function resetReverifyClientForTesting(): void {
  config = undefined;
}

function cfg(): ReverifyClientConfig {
  if (!config) config = loadClientConfig();
  return config;
}

const STATUSES = new Set<Deliverability>(['valid', 'risky', 'invalid', 'unknown']);

function allUnknown(assertionIds: readonly string[], now: Date): VerifyOutcome[] {
  return assertionIds.map((id) => ({ assertionId: id, status: 'unknown' as const, checkedAt: now }));
}

/**
 * IF-25a client. Every requested id gets exactly one outcome back, in the input order.
 *
 * [deviation: the LLD's own RPC contract already turns an *internal* timeout into `'unknown'`
 * ("Anything still pending comes back as unknown while the job continues in the background"). A
 * transport failure (network error, this client's own timeout, a 5xx, or a malformed response) is
 * a case the LLD text does not separately cover. Rather than fail the whole reveal closed on a
 * freshness-RPC outage — as M17's sanctions client deliberately does, for a materially different
 * reason (sanctions correctness must never be skipped) — this degrades every affected id to the
 * same `'unknown'`/stale outcome the RPC's own timeout path already produces, so a freshness
 * checker outage slows down reveal freshness rather than blocking a paid, revenue-critical action.]
 */
export async function reverify(
  ctx: ActorContext,
  assertionIds: readonly string[],
  trigger: ReverifyTrigger,
  triggerRef: string,
): Promise<VerifyOutcome[]> {
  if (assertionIds.length === 0) return [];
  if (assertionIds.length > REVERIFY_MAX_IDS) {
    throw new AppError('VALIDATION', `At most ${REVERIFY_MAX_IDS} assertion ids per reverify call`);
  }
  const c = cfg();
  let token: string;
  try {
    token = c.token();
  } catch (e) {
    log.error({ err: e, correlationId: ctx.correlationId }, 'm29 reverify: no internal RPC token configured; treating all as unknown');
    return allUnknown(assertionIds, new Date());
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
  let status = 0;
  let json: unknown;
  try {
    const res = await c.transport(`${c.baseUrl}${RPC_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': token,
        'x-correlation-id': ctx.correlationId,
      },
      body: JSON.stringify({ assertionIds: [...assertionIds], trigger, triggerRef }),
      signal: controller.signal,
    });
    status = res.status;
    json = await res.json().catch(() => undefined);
  } catch (e) {
    const timedOut = controller.signal.aborted;
    log.warn(
      { correlationId: ctx.correlationId, timedOut, err: e },
      'm29 reverify rpc failed; treating requested assertions as unknown',
    );
    return allUnknown(assertionIds, new Date());
  } finally {
    clearTimeout(timer);
  }

  if (status !== 200) {
    log.warn({ status, correlationId: ctx.correlationId }, 'm29 reverify rpc returned a non-200 status; treating as unknown');
    return allUnknown(assertionIds, new Date());
  }
  const body = json as { outcomes?: unknown } | undefined;
  if (!body || !Array.isArray(body.outcomes)) {
    log.warn({ correlationId: ctx.correlationId }, 'm29 reverify rpc returned a malformed response; treating as unknown');
    return allUnknown(assertionIds, new Date());
  }

  const byId = new Map<string, VerifyOutcome>();
  for (const raw of body.outcomes) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.assertionId === 'string' ? o.assertionId : undefined;
    const st = typeof o.status === 'string' && STATUSES.has(o.status as Deliverability) ? (o.status as Deliverability) : undefined;
    const checkedAt = typeof o.checkedAt === 'string' ? new Date(o.checkedAt) : undefined;
    if (id && st && checkedAt && !Number.isNaN(checkedAt.getTime())) byId.set(id, { assertionId: id, status: st, checkedAt });
  }
  const now = new Date();
  return assertionIds.map((id) => byId.get(id) ?? { assertionId: id, status: 'unknown' as const, checkedAt: now });
}
