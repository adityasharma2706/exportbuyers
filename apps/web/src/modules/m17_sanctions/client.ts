/**
 * M17 — TS client for IF-17a, the synchronous sanctions screening RPC served by the knowledge plane
 * (py/kp/m17_sanctions/rpc.py):
 *
 *   POST {KP_RPC_BASE_URL}/rpc/sanctions/screen  {companyId} | {name, country?}
 *     → {result: 'clear'|'possible'|'hit', listVersions, screenedAt}
 *
 * The server budget is 800 ms; the client allows a little more for the network. On a timeout, a
 * network error, a 5xx or any unexpected response the client FAILS CLOSED: it throws
 * UPSTREAM_UNAVAILABLE and the caller (reveal M29, draft M34) must not perform the action.
 * `assertSanctionsClear` additionally turns `hit` / `possible` into SANCTIONS_BLOCKED.
 * `screenOrUnknown` is for display-only checks (M31) that show "unknown" instead of failing.
 */
import { z } from 'zod';
import { AppError, getSecret, hasSecret, isUuid, log, type ActorContext } from '../m01_platform/index.js';

export const SANCTIONS_RESULTS = ['clear', 'possible', 'hit'] as const;
export type SanctionsResult = (typeof SANCTIONS_RESULTS)[number];

export type ScreenInput = { companyId: string } | { name: string; country?: string };

export interface ScreenDetail {
  result: SanctionsResult;
  listVersions: Record<string, string>;
  screenedAt: Date;
}

/** Minimal fetch-like transport, injectable for tests. */
export type SanctionsTransport = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface SanctionsClientConfig {
  baseUrl: string;
  /** Returns the shared internal token (KP_RPC_TOKEN). */
  token: () => string;
  timeoutMs: number;
  transport: SanctionsTransport;
}

export const RPC_PATH = '/rpc/sanctions/screen';
export const SERVER_TIMEOUT_MS = 800;
/** Server budget + network allowance [tunable]. */
export const DEFAULT_CLIENT_TIMEOUT_MS = 1_000;
const MAX_NAME_LEN = 500;

const responseSchema = z.object({
  result: z.enum(SANCTIONS_RESULTS),
  listVersions: z.record(z.string()),
  screenedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'screenedAt must be a timestamp'),
});

const defaultTransport: SanctionsTransport = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

function loadClientConfig(env: NodeJS.ProcessEnv = process.env): SanctionsClientConfig {
  const appEnv = env.APP_ENV ?? 'local';
  let baseUrl = env.KP_RPC_BASE_URL ?? '';
  if (!baseUrl) {
    if (appEnv === 'local' || appEnv === 'test') baseUrl = 'http://127.0.0.1:8081';
    else throw new AppError('INTERNAL', `KP_RPC_BASE_URL is required in ${appEnv}`);
  }
  const rawTimeout = env.SANCTIONS_RPC_TIMEOUT_MS;
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_CLIENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new AppError('VALIDATION', 'SANCTIONS_RPC_TIMEOUT_MS must be an integer in [100, 10000]');
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

let config: SanctionsClientConfig | undefined;

/** Overrides parts of the client configuration (tests, boot). Pass nothing to reload from env. */
export function configureSanctionsClient(over?: Partial<SanctionsClientConfig>): SanctionsClientConfig {
  const base = over && config ? config : loadClientConfig();
  config = { ...base, ...(over ?? {}) };
  return config;
}

export function resetSanctionsClientForTesting(): void {
  config = undefined;
}

function cfg(): SanctionsClientConfig {
  if (!config) config = loadClientConfig();
  return config;
}

function requestBody(input: ScreenInput): Record<string, string> {
  if ('companyId' in input) {
    if (!isUuid(input.companyId)) throw new AppError('VALIDATION', 'companyId must be a uuid');
    return { companyId: input.companyId.toLowerCase() };
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MAX_NAME_LEN) {
    throw new AppError('VALIDATION', `name must be 1..${MAX_NAME_LEN} characters`);
  }
  const body: Record<string, string> = { name };
  if (input.country !== undefined && input.country !== '') {
    if (!/^[A-Za-z]{2}$/.test(input.country)) throw new AppError('VALIDATION', 'country must be ISO 3166-1 alpha-2');
    body.country = input.country.toUpperCase();
  }
  return body;
}

function unavailable(reason: string, details: Record<string, unknown> = {}, cause?: unknown): AppError {
  return new AppError('UPSTREAM_UNAVAILABLE', 'Sanctions screening is unavailable', { reason, ...details }, { cause });
}

/** IF-17a with the full response. Fails closed (UPSTREAM_UNAVAILABLE). */
export async function screenDetailed(ctx: ActorContext, input: ScreenInput): Promise<ScreenDetail> {
  const body = requestBody(input);
  const c = cfg();
  const token = c.token();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
  const started = Date.now();
  let status = 0;
  let json: unknown = undefined;
  try {
    const res = await c.transport(`${c.baseUrl}${RPC_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': token,
        'x-correlation-id': ctx.correlationId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    status = res.status;
    json = await res.json().catch(() => undefined);
  } catch (e) {
    const timedOut = controller.signal.aborted;
    log.warn({ correlationId: ctx.correlationId, timedOut, ms: Date.now() - started }, 'm17 sanctions rpc failed');
    throw unavailable(timedOut ? 'timeout' : 'network', {}, e);
  } finally {
    clearTimeout(timer);
  }

  if (status === 200) {
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw unavailable('bad_response', { issues: parsed.error.message });
    return {
      result: parsed.data.result,
      listVersions: parsed.data.listVersions,
      screenedAt: new Date(parsed.data.screenedAt),
    };
  }
  const code = (json as { error?: { code?: unknown } } | undefined)?.error?.code;
  if (status === 400) throw new AppError('VALIDATION', 'Invalid sanctions screening request', { upstreamCode: code });
  if (status === 404) throw new AppError('NOT_FOUND', 'Company not found for sanctions screening');
  if (status === 401 || status === 403) {
    log.error({ status, correlationId: ctx.correlationId }, 'm17 sanctions rpc rejected the internal token');
  }
  throw unavailable('http_status', { status, upstreamCode: code });
}

/** IF-17a TS client: `screen(ctx, input): Promise<'clear'|'possible'|'hit'>`. Fails closed. */
export async function screen(ctx: ActorContext, input: ScreenInput): Promise<SanctionsResult> {
  return (await screenDetailed(ctx, input)).result;
}

/**
 * Guard for reveal and draft: resolves only when the company screens `clear`. `hit` or
 * `possible` → SANCTIONS_BLOCKED; unavailable → UPSTREAM_UNAVAILABLE (fail closed).
 */
export async function assertSanctionsClear(ctx: ActorContext, companyId: string): Promise<void> {
  const result = await screen(ctx, { companyId });
  if (result !== 'clear') {
    throw new AppError('SANCTIONS_BLOCKED', 'This company is blocked by sanctions screening', { result });
  }
}

/** For display-only checks: 'unknown' instead of throwing when the screener is unavailable. */
export async function screenOrUnknown(ctx: ActorContext, input: ScreenInput): Promise<SanctionsResult | 'unknown'> {
  try {
    return await screen(ctx, input);
  } catch (e) {
    if (e instanceof AppError && e.code === 'UPSTREAM_UNAVAILABLE') return 'unknown';
    throw e;
  }
}
