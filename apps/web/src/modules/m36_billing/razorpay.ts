/**
 * M36 — Razorpay Subscriptions client (UPI AutoPay, cards, net banking) and webhook signature
 * verification (LLD M36 "Webhook rules" rule 1).
 *
 * Follows M05's vendor pattern (vendors.ts): a plain `fetch`-based adapter behind a small
 * interface, with a settable override for tests, rather than the official `razorpay` SDK — this
 * keeps the dependency footprint the same shape as the rest of the codebase and makes the
 * Razorpay surface this module actually uses explicit and typed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, getSecret, log } from '../m01_platform/index.js';
import { billingConfig, SECRET_RAZORPAY_KEY_ID, SECRET_RAZORPAY_KEY_SECRET, SECRET_RAZORPAY_WEBHOOK_SECRET } from './config.js';

export interface RazorpaySubscriptionEntity {
  id: string;
  plan_id: string;
  status: string;
  current_start: number | null;
  current_end: number | null;
  short_url: string | null;
  total_count: number;
  notes: Record<string, string>;
}

export interface CreateSubscriptionParams {
  planId: string;
  totalCount: number;
  notes: Record<string, string>;
  customerNotify?: boolean;
}

export interface RazorpayClient {
  createSubscription(params: CreateSubscriptionParams): Promise<RazorpaySubscriptionEntity>;
  fetchSubscription(id: string): Promise<RazorpaySubscriptionEntity>;
  cancelSubscription(id: string, cancelAtCycleEnd: boolean): Promise<RazorpaySubscriptionEntity>;
}

function vendorError(retryable: boolean, message: string, cause?: unknown, status?: number): AppError {
  return new AppError('UPSTREAM_UNAVAILABLE', message, { vendor: 'razorpay', retryable, ...(status !== undefined ? { status } : {}) }, cause !== undefined ? { cause } : undefined);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function toEntity(body: unknown): RazorpaySubscriptionEntity {
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.status !== 'string') {
    throw vendorError(false, 'razorpay returned an unexpected subscription payload');
  }
  const notesRaw = body.notes;
  const notes: Record<string, string> = {};
  if (isRecord(notesRaw)) {
    for (const [k, v] of Object.entries(notesRaw)) notes[k] = String(v);
  }
  return {
    id: body.id,
    plan_id: typeof body.plan_id === 'string' ? body.plan_id : '',
    status: body.status,
    current_start: typeof body.current_start === 'number' ? body.current_start : null,
    current_end: typeof body.current_end === 'number' ? body.current_end : null,
    short_url: typeof body.short_url === 'string' ? body.short_url : null,
    total_count: typeof body.total_count === 'number' ? body.total_count : 0,
    notes,
  };
}

function authHeader(): string {
  const keyId = getSecret(SECRET_RAZORPAY_KEY_ID);
  const keySecret = getSecret(SECRET_RAZORPAY_KEY_SECRET);
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64')}`;
}

async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const cfg = billingConfig();
  const url = `${cfg.razorpayApiBase}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: authHeader(), 'content-type': 'application/json', accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(cfg.razorpayHttpTimeoutMs),
    });
  } catch (e) {
    throw vendorError(true, 'razorpay unreachable', e);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw vendorError(retryable, `razorpay returned HTTP ${res.status}`, text.slice(0, 500), res.status);
  }
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw vendorError(false, 'razorpay returned a non-JSON body', e);
  }
}

class HttpRazorpayClient implements RazorpayClient {
  async createSubscription(params: CreateSubscriptionParams): Promise<RazorpaySubscriptionEntity> {
    const body = await request('POST', '/subscriptions', {
      plan_id: params.planId,
      total_count: params.totalCount,
      customer_notify: params.customerNotify ?? true ? 1 : 0,
      notes: params.notes,
    });
    return toEntity(body);
  }

  async fetchSubscription(id: string): Promise<RazorpaySubscriptionEntity> {
    const body = await request('GET', `/subscriptions/${encodeURIComponent(id)}`);
    return toEntity(body);
  }

  async cancelSubscription(id: string, cancelAtCycleEnd: boolean): Promise<RazorpaySubscriptionEntity> {
    const body = await request('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, {
      cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0,
    });
    return toEntity(body);
  }
}

let client: RazorpayClient = new HttpRazorpayClient();

export function razorpay(): RazorpayClient {
  return client;
}

/** Test hook (undefined restores the real fetch-based client). */
export function setRazorpayClientForTesting(c: RazorpayClient | undefined): void {
  client = c ?? new HttpRazorpayClient();
}

// ---- webhook signature (LLD M36 Webhook rules #1) --------------------------------------------

/**
 * `HMAC_SHA256(webhook_secret, raw_body)` with a constant-time compare. Verification (not
 * signing), so length mismatches are handled explicitly rather than throwing out of
 * timingSafeEqual.
 */
export function verifyRazorpayWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;
  let secret: string;
  try {
    secret = getSecret(SECRET_RAZORPAY_WEBHOOK_SECRET);
  } catch (err) {
    log.error({ err }, 'm36: RAZORPAY_WEBHOOK_SECRET is not configured');
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const gotBuf = Buffer.from(signatureHeader.trim().toLowerCase(), 'hex');
  if (expectedBuf.length !== gotBuf.length || gotBuf.length === 0) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}
