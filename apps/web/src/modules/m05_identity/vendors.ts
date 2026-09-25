/**
 * M05 — SMS (DLT-registered) and transactional email (ESP) vendor adapters.
 * LLD decision "ESP ownership": M05 owns sendTransactionalEmail / sendSms; M41 wraps them.
 *
 * Launch vendor [assumption]: MSG91 for both channels (Indian vendor, DLT flow templates for
 * SMS, template-based email API). Local/test use a console adapter that only logs.
 *
 * Failures: a vendor error never surfaces as a 500. Transport errors, timeouts, 429 and 5xx
 * are retryable UPSTREAM_UNAVAILABLE; other 4xx are UPSTREAM_UNAVAILABLE with
 * details.retryable=false (our request or config is wrong). Emails sent with an
 * idempotencyKey are retried through the `m05.send_email` job instead of failing the caller.
 */
import {
  AppError,
  getRedis,
  getSecret,
  log,
  recordCost,
  systemDb,
} from '../m01_platform/index.js';
import { NonRetryable, enqueue, registerHandler, type PayloadSchema } from '../m02_queue/index.js';
import { identityConfig } from './config.js';
import { isValidEmail, isValidE164 } from './validate.js';

export const SECRET_MSG91_AUTH_KEY = 'M05_MSG91_AUTH_KEY';
export const SEND_EMAIL_JOB = 'm05.send_email';

/** Unit costs in micro-INR [tunable]; recorded through M01 IF-01b. */
const SMS_COST_MICROS_INR = 250_000;
const EMAIL_COST_MICROS_INR = 20_000;

export interface EmailMessage {
  to: string;
  templateKey: string;
  params: Record<string, unknown>;
}

export interface SmsProvider {
  readonly name: string;
  send(toE164: string, dltTemplateId: string, params: readonly string[]): Promise<void>;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<void>;
}

// ---- errors -------------------------------------------------------------------------------

function vendorError(vendor: string, retryable: boolean, message: string, cause?: unknown, status?: number): AppError {
  return new AppError(
    'UPSTREAM_UNAVAILABLE',
    message,
    { vendor, retryable, ...(status !== undefined ? { status } : {}) },
    cause !== undefined ? { cause } : undefined,
  );
}

export function isRetryableVendorError(e: unknown): boolean {
  return e instanceof AppError && e.code === 'UPSTREAM_UNAVAILABLE' && e.details?.retryable !== false;
}

async function postJson(vendor: string, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const timeoutMs = identityConfig().vendors.httpTimeoutMs;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw vendorError(vendor, true, `${vendor} unreachable`, e);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw vendorError(vendor, retryable, `${vendor} returned HTTP ${res.status}`, text.slice(0, 500), res.status);
  }
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

// ---- MSG91 --------------------------------------------------------------------------------

/** MSG91 answers 200 with {type:'error'} for some rejections. */
function assertMsg91Ok(vendor: string, body: unknown): void {
  if (body && typeof body === 'object' && (body as { type?: unknown }).type === 'error') {
    const msg = String((body as { message?: unknown }).message ?? 'rejected');
    throw vendorError(vendor, false, `${vendor} rejected the request: ${msg}`);
  }
}

export class Msg91SmsProvider implements SmsProvider {
  readonly name = 'msg91_sms';
  async send(toE164: string, dltTemplateId: string, params: readonly string[]): Promise<void> {
    const recipient: Record<string, string> = { mobiles: toE164.replace(/^\+/, '') };
    params.forEach((p, i) => {
      recipient[`var${i + 1}`] = p;
    });
    const body = await postJson(
      this.name,
      'https://control.msg91.com/api/v5/flow',
      { authkey: getSecret(SECRET_MSG91_AUTH_KEY) },
      { template_id: dltTemplateId, short_url: '0', recipients: [recipient] },
    );
    assertMsg91Ok(this.name, body);
  }
}

export class Msg91EmailProvider implements EmailProvider {
  readonly name = 'msg91_email';
  async send(msg: EmailMessage): Promise<void> {
    const v = identityConfig().vendors;
    const templateId = v.emailTemplates[msg.templateKey] ?? msg.templateKey;
    const body = await postJson(
      this.name,
      'https://control.msg91.com/api/v5/email/send',
      { authkey: getSecret(SECRET_MSG91_AUTH_KEY) },
      {
        recipients: [{ to: [{ email: msg.to }], variables: msg.params }],
        from: { email: v.emailFrom, name: v.emailFromName },
        domain: v.emailDomain,
        template_id: templateId,
      },
    );
    assertMsg91Ok(this.name, body);
  }
}

// ---- console (local/test) -----------------------------------------------------------------

export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console_sms';
  readonly sent: Array<{ to: string; templateId: string; params: readonly string[] }> = [];
  async send(toE164: string, dltTemplateId: string, params: readonly string[]): Promise<void> {
    this.sent.push({ to: toE164, templateId: dltTemplateId, params });
    log.info({ to: toE164, dltTemplateId, params }, '[console sms] message');
  }
}

export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console_email';
  readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
    log.info({ to: msg.to, templateKey: msg.templateKey, params: msg.params }, '[console email] message');
  }
}

let smsProvider: SmsProvider | undefined;
let emailProvider: EmailProvider | undefined;

function sms(): SmsProvider {
  if (!smsProvider) smsProvider = identityConfig().vendors.sms === 'msg91' ? new Msg91SmsProvider() : new ConsoleSmsProvider();
  return smsProvider;
}

function email(): EmailProvider {
  if (!emailProvider) {
    emailProvider = identityConfig().vendors.email === 'msg91' ? new Msg91EmailProvider() : new ConsoleEmailProvider();
  }
  return emailProvider;
}

/** Swap vendor adapters (tests, or a vendor change behind the same interface). */
export function setVendorProviders(p: { sms?: SmsProvider; email?: EmailProvider }): void {
  if (p.sms) smsProvider = p.sms;
  if (p.email) emailProvider = p.email;
}

// ---- public API ---------------------------------------------------------------------------

/** Sends a DLT-template SMS. Throws UPSTREAM_UNAVAILABLE when the vendor fails. */
export async function sendSms(toE164: string, dltTemplateId: string, params: string[]): Promise<void> {
  if (!isValidE164(toE164)) throw new AppError('VALIDATION', 'Phone number must be in E.164 format');
  if (typeof dltTemplateId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(dltTemplateId)) {
    throw new AppError('INTERNAL', 'SMS DLT template id is not configured');
  }
  if (!Array.isArray(params) || params.some((p) => typeof p !== 'string')) {
    throw new AppError('VALIDATION', 'SMS params must be strings');
  }
  const p = sms();
  await p.send(toE164, dltTemplateId, params);
  recordCost({ vendor: p.name, op: 'sms.send', units: 1, costMicrosInr: SMS_COST_MICROS_INR });
}

async function deliverEmail(msg: EmailMessage, jobType?: string): Promise<void> {
  const p = email();
  await p.send(msg);
  recordCost({
    vendor: p.name,
    op: 'email.send',
    units: 1,
    costMicrosInr: EMAIL_COST_MICROS_INR,
    ...(jobType !== undefined ? { jobType } : {}),
  });
}

const SENT_KEY_TTL_SEC = 7 * 24 * 3600;
const sentKey = (idempotencyKey: string): string => `m05:email:sent:${idempotencyKey}`;

/**
 * Sends a transactional email. Without an idempotencyKey a vendor failure throws
 * UPSTREAM_UNAVAILABLE. With one, the send is de-duplicated for 7 days and a retryable
 * failure is handed to the `m05.send_email` job (the promise resolves once it is queued).
 */
export async function sendTransactionalEmail(
  to: string,
  templateKey: string,
  params: object,
  opts?: { idempotencyKey: string },
): Promise<void> {
  const addr = typeof to === 'string' ? to.trim() : '';
  if (!isValidEmail(addr)) throw new AppError('VALIDATION', 'Invalid email address');
  if (typeof templateKey !== 'string' || !/^[a-z0-9_.-]{1,100}$/i.test(templateKey)) {
    throw new AppError('VALIDATION', 'Invalid email template key');
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new AppError('VALIDATION', 'Email params must be an object');
  }
  const msg: EmailMessage = { to: addr, templateKey, params: { ...(params as Record<string, unknown>) } };
  const key = opts?.idempotencyKey;
  if (key === undefined) {
    await deliverEmail(msg);
    return;
  }
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
    throw new AppError('VALIDATION', 'idempotencyKey must be 1..200 characters');
  }
  if ((await getRedis().get(sentKey(key))) !== null) return;
  try {
    await deliverEmail(msg);
    await getRedis().set(sentKey(key), '1', 'EX', SENT_KEY_TTL_SEC);
  } catch (e) {
    if (!isRetryableVendorError(e)) throw e;
    log.warn({ err: e, templateKey, idempotencyKey: key }, 'email send failed; queued for retry');
    await enqueue(systemDb('m05 queue transactional email retry'), {
      type: SEND_EMAIL_JOB,
      queue: 'serving',
      payload: { v: 1, ...msg, idempotencyKey: key } satisfies SendEmailPayload,
      idempotencyKey: `${SEND_EMAIL_JOB}:${key}`,
      maxAttempts: 8,
    });
  }
}

// ---- job ----------------------------------------------------------------------------------

export interface SendEmailPayload {
  v: 1;
  to: string;
  templateKey: string;
  params: Record<string, unknown>;
  idempotencyKey: string;
}

export const sendEmailPayloadSchema: PayloadSchema<SendEmailPayload> = {
  safeParse(input: unknown) {
    const fail = (message: string) => ({ success: false as const, error: { message } });
    if (input === null || typeof input !== 'object') return fail('payload must be an object');
    const o = input as Record<string, unknown>;
    if (o.v !== 1) return fail('v must be 1');
    if (typeof o.to !== 'string' || !isValidEmail(o.to)) return fail('to must be an email address');
    if (typeof o.templateKey !== 'string' || o.templateKey === '') return fail('templateKey required');
    if (o.params === null || typeof o.params !== 'object' || Array.isArray(o.params)) return fail('params must be an object');
    if (typeof o.idempotencyKey !== 'string' || o.idempotencyKey === '') return fail('idempotencyKey required');
    return {
      success: true as const,
      data: {
        v: 1,
        to: o.to,
        templateKey: o.templateKey,
        params: o.params as Record<string, unknown>,
        idempotencyKey: o.idempotencyKey,
      },
    };
  },
};

let jobsRegistered = false;

/** Registers the `m05.send_email` handler with M02 (called from registerIdentityJobs). */
export function registerEmailJob(): void {
  if (jobsRegistered) return;
  registerHandler(SEND_EMAIL_JOB, sendEmailPayloadSchema, async (p, meta) => {
    if ((await getRedis().get(sentKey(p.idempotencyKey))) !== null) return;
    try {
      await deliverEmail({ to: p.to, templateKey: p.templateKey, params: p.params }, meta.type);
    } catch (e) {
      if (!isRetryableVendorError(e)) throw new NonRetryable('email vendor rejected the message', { cause: e });
      throw e;
    }
    await getRedis().set(sentKey(p.idempotencyKey), '1', 'EX', SENT_KEY_TTL_SEC);
  });
  jobsRegistered = true;
}
