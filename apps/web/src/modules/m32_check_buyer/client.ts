/**
 * M32 — TS client for IF-24b, the ad hoc trust-check RPC served by the knowledge plane
 * (py/kp/m24_trust/rpc.py):
 *
 *   POST {KP_RPC_BASE_URL}/rpc/trust/adhoc  {name?, email?, website?, country?}
 *     -> 200 RollupResult.to_dict() {level, ruleVersion, copyVersion, computedAt, checks: [...]}
 *
 * Mirrors M17's sanctions client (m17_sanctions/client.ts) byte for byte in shape: same
 * `x-internal-token` (KP_RPC_TOKEN) convention, same fail-closed contract. The server's own budget
 * is 8 s (py `RPC_BUDGET_S`) and per LLD M24 "this endpoint never legitimately times out from the
 * caller's point of view" — every check degrades to `unknown` on its own 3 s budget rather than
 * failing the whole request — so a client-side timeout or 5xx here means the RPC process itself is
 * down, not merely slow; UPSTREAM_UNAVAILABLE is thrown in exactly that case (LLD M32 does not list
 * a "trust unavailable" outcome for /api/check, so the caller must decide whether to still charge
 * and answer with an `unknown` trust result, or fail the whole check — see service.ts).
 */
import { z } from 'zod';
import { AppError, getSecret, hasSecret, log, type ActorContext } from '../m01_platform/index.js';
import type { TrustAdhocResultDto } from './types.js';

export interface TrustAdhocInput {
  name?: string;
  email?: string;
  website?: string;
  country?: string;
}

/** Minimal fetch-like transport, injectable for tests (mirrors M17's SanctionsTransport). */
export type TrustAdhocTransport = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface TrustAdhocClientConfig {
  baseUrl: string;
  token: () => string;
  timeoutMs: number;
  transport: TrustAdhocTransport;
}

export const RPC_PATH = '/rpc/trust/adhoc';
export const SERVER_TIMEOUT_MS = 8_000;
/** Server budget + network allowance [tunable]. */
export const DEFAULT_CLIENT_TIMEOUT_MS = 9_000;
const MAX_NAME_LEN = 500;
const MAX_EMAIL_LEN = 320;
const MAX_WEBSITE_LEN = 2048;

const checkSchema = z.object({
  id: z.string(),
  outcome: z.enum(['pass', 'fail', 'unknown']),
  checkedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'checkedAt must be a timestamp'),
  explanationKey: z.string(),
  assertionId: z.string().nullable(),
});

const responseSchema = z.object({
  level: z.enum(['high', 'medium', 'low', 'unknown']),
  ruleVersion: z.number(),
  copyVersion: z.string(),
  computedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'computedAt must be a timestamp'),
  checks: z.array(checkSchema),
});

const defaultTransport: TrustAdhocTransport = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

function loadClientConfig(env: NodeJS.ProcessEnv = process.env): TrustAdhocClientConfig {
  const appEnv = env.APP_ENV ?? 'local';
  let baseUrl = env.KP_RPC_BASE_URL ?? '';
  if (!baseUrl) {
    if (appEnv === 'local' || appEnv === 'test') baseUrl = 'http://127.0.0.1:8081';
    else throw new AppError('INTERNAL', `KP_RPC_BASE_URL is required in ${appEnv}`);
  }
  const rawTimeout = env.M32_TRUST_RPC_TIMEOUT_MS;
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_CLIENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new AppError('VALIDATION', 'M32_TRUST_RPC_TIMEOUT_MS must be an integer in [100, 30000]');
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

let config: TrustAdhocClientConfig | undefined;

export function configureTrustAdhocClient(over?: Partial<TrustAdhocClientConfig>): TrustAdhocClientConfig {
  const base = over && config ? config : loadClientConfig();
  config = { ...base, ...(over ?? {}) };
  return config;
}

export function resetTrustAdhocClientForTesting(): void {
  config = undefined;
}

function cfg(): TrustAdhocClientConfig {
  if (!config) config = loadClientConfig();
  return config;
}

function trimmed(v: string | undefined, max: number, field: string): string | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (s.length === 0) return undefined;
  if (s.length > max) throw new AppError('VALIDATION', `${field} must be at most ${max} characters`, { field });
  return s;
}

function requestBody(input: TrustAdhocInput): Record<string, string> {
  const name = trimmed(input.name, MAX_NAME_LEN, 'name');
  const email = trimmed(input.email, MAX_EMAIL_LEN, 'email');
  const website = trimmed(input.website, MAX_WEBSITE_LEN, 'website');
  if (!name && !email && !website) {
    throw new AppError('VALIDATION', 'Send at least one of name, email or website', { field: 'name' });
  }
  const body: Record<string, string> = {};
  if (name) body.name = name;
  if (email) body.email = email;
  if (website) body.website = website;
  if (input.country !== undefined && input.country.trim() !== '') {
    if (!/^[A-Za-z]{2}$/.test(input.country.trim())) throw new AppError('VALIDATION', 'country must be ISO 3166-1 alpha-2', { field: 'country' });
    body.country = input.country.trim().toUpperCase();
  }
  return body;
}

function unavailable(reason: string, details: Record<string, unknown> = {}, cause?: unknown): AppError {
  return new AppError('UPSTREAM_UNAVAILABLE', 'Trust checking is unavailable', { reason, ...details }, { cause });
}

/** IF-24b client. Fails closed (UPSTREAM_UNAVAILABLE) on a timeout, network error, 5xx or a
 * malformed 200 body — never returns a made-up result. */
export async function evaluateAdhocTrust(ctx: ActorContext, input: TrustAdhocInput): Promise<TrustAdhocResultDto> {
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
    log.warn({ correlationId: ctx.correlationId, timedOut, ms: Date.now() - started }, 'm32 trust adhoc rpc failed');
    throw unavailable(timedOut ? 'timeout' : 'network', {}, e);
  } finally {
    clearTimeout(timer);
  }

  if (status === 200) {
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw unavailable('bad_response', { issues: parsed.error.message });
    return parsed.data;
  }
  const code = (json as { error?: { code?: unknown } } | undefined)?.error?.code;
  if (status === 400) throw new AppError('VALIDATION', 'Invalid trust check request', { upstreamCode: code });
  if (status === 401 || status === 403) {
    log.error({ status, correlationId: ctx.correlationId }, 'm32 trust adhoc rpc rejected the internal token');
  }
  throw unavailable('http_status', { status, upstreamCode: code });
}
