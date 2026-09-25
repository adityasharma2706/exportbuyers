/**
 * M05 — anonymous access guard (IF-05c) with bot protection. REQ-004.
 *
 * Per bucket, an anonymous visitor may make `limit` requests per hour, counted per IP +
 * device (the signed `did` cookie). Once 50% [tunable] of the limit is used, further requests
 * need a Cloudflare Turnstile token (header `cf-turnstile-response` or `x-turnstile-token`);
 * without one the guard throws RATE_LIMITED with details.challenge=true. A passed challenge
 * is honoured for an hour for that IP + device. Signed-in actors are not throttled here.
 */
import { AppError, getRedis, getSecret, hasSecret, log, rateLimited, type ActorContext } from '../m01_platform/index.js';
import { ANON_BUCKETS, identityConfig, type AnonBucket } from './config.js';
import { keyHash } from './crypto.js';
import { rateStore } from './rateLimit.js';
import { clientIp, requestMetaOf, type HttpRequestLike } from './session.js';

export const SECRET_TURNSTILE = 'TURNSTILE_SECRET_KEY';

export type TurnstileVerifier = (token: string, ip: string) => Promise<boolean>;

/** Cloudflare Turnstile siteverify. Returns true/false; throws UPSTREAM_UNAVAILABLE on outage. */
export const cloudflareTurnstile: TurnstileVerifier = async (token, ip) => {
  const form = new URLSearchParams({ secret: getSecret(SECRET_TURNSTILE), response: token, remoteip: ip });
  let res: Response;
  try {
    res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(identityConfig().vendors.httpTimeoutMs),
    });
  } catch (e) {
    throw new AppError('UPSTREAM_UNAVAILABLE', 'Turnstile unreachable', { vendor: 'turnstile' }, { cause: e });
  }
  if (!res.ok) throw new AppError('UPSTREAM_UNAVAILABLE', `Turnstile returned HTTP ${res.status}`, { vendor: 'turnstile' });
  const body = (await res.json().catch(() => ({}))) as { success?: unknown };
  return body.success === true;
};

let verifier: TurnstileVerifier | undefined;

function turnstile(): TurnstileVerifier | undefined {
  if (verifier) return verifier;
  return hasSecret(SECRET_TURNSTILE) ? cloudflareTurnstile : undefined;
}

export function setTurnstileVerifier(v: TurnstileVerifier | undefined): void {
  verifier = v;
}

function tokenFrom(req: HttpRequestLike | undefined): string | undefined {
  if (!req) return undefined;
  for (const h of ['cf-turnstile-response', 'x-turnstile-token']) {
    const v = req.headers[h];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string' && s.length > 0 && s.length <= 2048) return s;
  }
  return undefined;
}

const passKey = (ipH: string, devH: string): string => `m05:turnstile:pass:${ipH}:${devH}`;

/** Resolves the IP and device for the context, with a fallback for copied contexts. */
function identify(ctx: ActorContext): { ip: string; deviceId: string; req?: HttpRequestLike } {
  const meta = requestMetaOf(ctx);
  if (meta) return { ip: meta.ip, deviceId: meta.deviceId, req: meta.req };
  if (!ctx.anonSessionId) throw new AppError('INTERNAL', 'guardAnonymous needs a context from resolveSession()');
  log.warn({ correlationId: ctx.correlationId }, 'guardAnonymous: request details missing; keying on the anonymous session');
  return { ip: 'unknown', deviceId: ctx.anonSessionId };
}

/**
 * IF-05c. Throws RATE_LIMITED (with retryAfterSec) when the bucket is exhausted, or
 * RATE_LIMITED with details.challenge=true when a Turnstile challenge is needed first.
 * `req` may be passed explicitly when the context was not produced from the same request object.
 */
export async function guardAnonymous(ctx: ActorContext, bucket: AnonBucket, req?: HttpRequestLike): Promise<void> {
  if (!ANON_BUCKETS.includes(bucket)) throw new AppError('INTERNAL', `Unknown anonymous bucket "${String(bucket)}"`);
  if (ctx.kind !== 'anonymous') return;
  const cfg = identityConfig().anon;
  const limit = cfg.limits[bucket];
  const id = identify(ctx);
  const request = req ?? id.req;
  const ip = req ? clientIp(req) : id.ip;
  const ipH = keyHash('ip', ip);
  const devH = keyHash('dev', id.deviceId);
  const window = { key: `m05:anon:${bucket}:${ipH}:${devH}`, limit, windowSec: cfg.windowSec };
  const now = Date.now();

  const peek = await rateStore().hit([window], now, false);
  if (!peek.allowed) {
    throw rateLimited(peek.retryAfterSec, 'Too many requests; sign up for more', { bucket, limit, signupSuggested: true });
  }

  const used = peek.counts[0] ?? 0;
  const threshold = Math.max(1, Math.ceil(limit * cfg.challengeAt));
  if (used >= threshold) await requireChallenge(request, ip, ipH, devH, bucket, cfg.challengePassTtlSec);

  const r = await rateStore().hit([window], now, true);
  if (!r.allowed) {
    throw rateLimited(r.retryAfterSec, 'Too many requests; sign up for more', { bucket, limit, signupSuggested: true });
  }
}

async function requireChallenge(
  req: HttpRequestLike | undefined,
  ip: string,
  ipH: string,
  devH: string,
  bucket: AnonBucket,
  passTtlSec: number,
): Promise<void> {
  const redis = getRedis();
  if ((await redis.get(passKey(ipH, devH))) !== null) return;
  const v = turnstile();
  if (!v) {
    log.warn({ bucket }, 'Turnstile not configured; challenge step skipped');
    return;
  }
  const token = tokenFrom(req);
  if (!token) throw rateLimited(1, 'Please complete the challenge to continue', { bucket, challenge: true });
  let ok: boolean;
  try {
    ok = await v(token, ip);
  } catch (err) {
    // Degrade: the hard per-bucket limit still applies, so a Turnstile outage does not lock
    // out real visitors.
    log.warn({ err, bucket }, 'Turnstile verification unavailable; allowing within the hard limit');
    return;
  }
  if (!ok) throw rateLimited(1, 'Challenge failed; please try again', { bucket, challenge: true });
  await redis.set(passKey(ipH, devH), '1', 'EX', passTtlSec);
}
