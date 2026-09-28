/**
 * M43 — the Razorpay Refunds client (LLD M43: "Razorpay refund API (idempotent via the
 * receipt)").
 *
 * [deviation: M36's own `razorpay.ts` (IF-36's `RazorpayClient`) only covers Subscriptions
 * (create/fetch/cancel); it has no refund method, and its `request()`/`authHeader()` HTTP
 * plumbing is private to that file (not exported through M36's public index.ts). This module
 * therefore has its own small `fetch`-based adapter, following the exact same shape M36's does
 * (M36 `billingConfig()` for the API base/timeout, M36's exported `SECRET_RAZORPAY_KEY_ID` /
 * `SECRET_RAZORPAY_KEY_SECRET` secret names for Basic auth), rather than duplicating a "generic
 * Razorpay HTTP client" module M36 does not itself expose.]
 *
 * Idempotency: Razorpay's refund-creation endpoint does not itself dedupe repeated calls by a
 * caller-supplied `receipt` the way M28's ledger does by `idempotencyKey` — so before ever
 * POSTing a refund, this always lists the payment's existing refunds first and returns the one
 * already carrying our `receipt` in its notes, if any. A retried `billing.money_back` outcome
 * handler (LLD M11: a failing `onOutcome` is retried by the queue) therefore never creates a
 * second refund for the same approved request.
 */
import { AppError, getSecret } from '../m01_platform/index.js';
import { billingConfig, SECRET_RAZORPAY_KEY_ID, SECRET_RAZORPAY_KEY_SECRET } from '../m36_billing/index.js';

export interface RazorpayRefundEntity {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: string;
  notes: Record<string, string>;
}

export interface RazorpayRefundClient {
  /** Returns the refund already on file for `receipt` if one exists, otherwise creates one. */
  refundPayment(paymentId: string, amountPaise: number, receipt: string, notes: Record<string, string>): Promise<RazorpayRefundEntity>;
}

function vendorError(retryable: boolean, message: string, cause?: unknown, status?: number): AppError {
  return new AppError(
    'UPSTREAM_UNAVAILABLE',
    message,
    { vendor: 'razorpay', retryable, ...(status !== undefined ? { status } : {}) },
    cause !== undefined ? { cause } : undefined,
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function toNotes(v: unknown): Record<string, string> {
  const notes: Record<string, string> = {};
  if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) notes[k] = String(val);
  }
  return notes;
}

function toRefundEntity(body: unknown): RazorpayRefundEntity {
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.payment_id !== 'string') {
    throw vendorError(false, 'razorpay returned an unexpected refund payload');
  }
  return {
    id: body.id,
    paymentId: body.payment_id,
    amountPaise: typeof body.amount === 'number' ? body.amount : 0,
    status: typeof body.status === 'string' ? body.status : 'unknown',
    notes: toNotes(body.notes),
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

class HttpRazorpayRefundClient implements RazorpayRefundClient {
  async refundPayment(paymentId: string, amountPaise: number, receipt: string, notes: Record<string, string>): Promise<RazorpayRefundEntity> {
    const existing = await this.findByReceipt(paymentId, receipt);
    if (existing) return existing;

    const body = await request('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, {
      amount: amountPaise,
      speed: 'normal',
      receipt,
      notes: { ...notes, receipt },
    });
    return toRefundEntity(body);
  }

  private async findByReceipt(paymentId: string, receipt: string): Promise<RazorpayRefundEntity | null> {
    const body = await request('GET', `/payments/${encodeURIComponent(paymentId)}/refunds`);
    if (!isRecord(body) || !Array.isArray(body.items)) return null;
    for (const item of body.items) {
      if (!isRecord(item)) continue;
      const notes = toNotes(item.notes);
      if (notes.receipt === receipt) return toRefundEntity(item);
    }
    return null;
  }
}

let client: RazorpayRefundClient = new HttpRazorpayRefundClient();

export function razorpayRefundClient(): RazorpayRefundClient {
  return client;
}

/** Test hook (undefined restores the real fetch-based client). */
export function setRazorpayRefundClientForTesting(c: RazorpayRefundClient | undefined): void {
  client = c ?? new HttpRazorpayRefundClient();
}
