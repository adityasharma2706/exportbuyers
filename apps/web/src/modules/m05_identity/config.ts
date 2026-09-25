/**
 * M05 — tunable settings (LLD M05 Rules). Values marked [tunable] in the LLD live here as
 * defaults and can be overridden through environment variables at boot. Secrets (pepper,
 * encryption keys, vendor keys) are NOT here: they come from M01 getSecret().
 */
import { AppError } from '../m01_platform/index.js';

export type AnonBucket = 'hs' | 'market' | 'search_preview' | 'public_form' | 'check';
export const ANON_BUCKETS: readonly AnonBucket[] = ['hs', 'market', 'search_preview', 'public_form', 'check'];

export interface IdentityConfig {
  otp: {
    digits: 6;
    ttlSec: number;
    maxVerifyAttempts: number;
    resendAfterSec: number;
    perDestination: { limit: number; windowSec: number };
    perIp: { limit: number; windowSec: number };
    /** SMS is allowed only to these E.164 country prefixes at launch [assumption]. */
    smsAllowedPrefixes: readonly string[];
  };
  session: {
    userTtlSec: number;
    adminTtlSec: number;
    /** Sliding refresh is written at most this often, to keep hot sessions from writing every request. */
    touchIntervalSec: number;
    /** Anonymous session rows one IP may create per hour before new visitors get an unpersisted context. */
    anonCreatePerIpPerHour: number;
  };
  anon: {
    windowSec: number;
    limits: Readonly<Record<AnonBucket, number>>;
    /** Fraction of a limit after which a Turnstile challenge is required. */
    challengeAt: number;
    /** How long a passed Turnstile challenge is honoured for one IP+device. */
    challengePassTtlSec: number;
  };
  mfa: {
    stepSec: number;
    window: number;
    attemptsPer15Min: number;
  };
  cookies: {
    sessionName: string;
    deviceName: string;
    deviceTtlSec: number;
    /** Secure is dropped only for local development over http. */
    secure: boolean;
  };
  vendors: {
    sms: 'msg91' | 'console';
    email: 'msg91' | 'console';
    httpTimeoutMs: number;
    smsOtpDltTemplateId: string;
    emailFrom: string;
    emailFromName: string;
    emailDomain: string;
    /** templateKey → vendor template id. Keys without an entry are sent under their own name. */
    emailTemplates: Readonly<Record<string, string>>;
  };
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError('VALIDATION', `Config ${key} must be an integer in [${min}, ${max}]; got "${raw}"`, { key });
  }
  return n;
}

function parseTemplates(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AppError('VALIDATION', 'M05_EMAIL_TEMPLATES must be a JSON object', undefined, { cause: e });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('VALIDATION', 'M05_EMAIL_TEMPLATES must be a JSON object');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string' || v === '') throw new AppError('VALIDATION', `M05_EMAIL_TEMPLATES.${k} must be a non-empty string`);
    out[k] = v;
  }
  return out;
}

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const appEnv = env.APP_ENV ?? 'local';
  const isDev = appEnv === 'local' || appEnv === 'test';
  const vendorDefault = isDev ? 'console' : 'msg91';
  const sms = (env.M05_SMS_VENDOR ?? vendorDefault) as IdentityConfig['vendors']['sms'];
  const email = (env.M05_EMAIL_VENDOR ?? vendorDefault) as IdentityConfig['vendors']['email'];
  for (const [k, v] of [['M05_SMS_VENDOR', sms], ['M05_EMAIL_VENDOR', email]] as const) {
    if (v !== 'msg91' && v !== 'console') throw new AppError('VALIDATION', `${k} must be msg91 or console`);
    if (v === 'console' && !isDev) throw new AppError('VALIDATION', `${k}=console is only allowed in local/test`);
  }
  const domain = env.M05_EMAIL_DOMAIN ?? 'example.in';
  const challengePct = int(env, 'M05_ANON_CHALLENGE_PCT', 50, 1, 100);
  return {
    otp: {
      digits: 6,
      ttlSec: 10 * 60,
      maxVerifyAttempts: 5,
      resendAfterSec: 30,
      perDestination: { limit: int(env, 'M05_OTP_PER_DEST_LIMIT', 3, 1, 100), windowSec: 15 * 60 },
      perIp: { limit: int(env, 'M05_OTP_PER_IP_LIMIT', 10, 1, 10_000), windowSec: 60 * 60 },
      smsAllowedPrefixes: ['+91'],
    },
    session: {
      userTtlSec: 30 * 24 * 3600,
      adminTtlSec: 12 * 3600,
      touchIntervalSec: int(env, 'M05_SESSION_TOUCH_SEC', 300, 0, 86_400),
      anonCreatePerIpPerHour: int(env, 'M05_ANON_CREATE_PER_IP_HOUR', 120, 1, 1_000_000),
    },
    anon: {
      windowSec: 3600,
      limits: Object.freeze({
        hs: int(env, 'M05_ANON_LIMIT_HS', 30, 1, 100_000),
        market: int(env, 'M05_ANON_LIMIT_MARKET', 30, 1, 100_000),
        search_preview: int(env, 'M05_ANON_LIMIT_SEARCH_PREVIEW', 10, 1, 100_000),
        check: int(env, 'M05_ANON_LIMIT_CHECK', 3, 1, 100_000),
        public_form: int(env, 'M05_ANON_LIMIT_PUBLIC_FORM', 5, 1, 100_000),
      }),
      challengeAt: challengePct / 100,
      challengePassTtlSec: 3600,
    },
    mfa: { stepSec: 30, window: 1, attemptsPer15Min: 5 },
    cookies: {
      sessionName: 'sid',
      deviceName: 'did',
      deviceTtlSec: 365 * 24 * 3600,
      secure: appEnv !== 'local',
    },
    vendors: {
      sms,
      email,
      httpTimeoutMs: int(env, 'M05_VENDOR_TIMEOUT_MS', 8_000, 500, 60_000),
      smsOtpDltTemplateId: env.M05_SMS_OTP_DLT_TEMPLATE_ID ?? '',
      emailFrom: env.M05_EMAIL_FROM ?? `no-reply@notify.${domain}`,
      emailFromName: env.M05_EMAIL_FROM_NAME ?? 'ExportBuyers',
      emailDomain: env.M05_EMAIL_SENDING_DOMAIN ?? `notify.${domain}`,
      emailTemplates: Object.freeze(parseTemplates(env.M05_EMAIL_TEMPLATES)),
    },
  };
}

let current: IdentityConfig | undefined;

export function identityConfig(): IdentityConfig {
  if (!current) current = loadIdentityConfig();
  return current;
}

/** Replace the config (boot with a custom env, or tests). */
export function setIdentityConfig(cfg: IdentityConfig): void {
  current = cfg;
}
