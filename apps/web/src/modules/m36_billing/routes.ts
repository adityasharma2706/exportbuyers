/**
 * M36 — HTTP routes (LLD M36 "API").
 *   GET  /api/plans                          (public)              -> 200 plan catalogue (INR)
 *   POST /api/billing/checkout {plan, cycle} (signed in)            -> 200 {razorpaySubscriptionId, keyId}
 *   POST /api/billing/cancel {atPeriodEnd}   (signed in)            -> 200 {cancelAtPeriodEnd, status}
 *   POST /api/billing/update-method          (signed in)            -> 200 {shortUrl}
 *   PUT  /api/billing/details {...}          (signed in)            -> 200 billing details   [addition, see subscriptions.ts]
 *   GET  /api/billing/details                (signed in)            -> 200 billing details | 404
 *   GET  /api/invoices                       (signed in)            -> 200 {items: [...]}
 *   GET  /api/invoices/:id/pdf               (signed in)            -> 200 application/pdf
 *   POST /webhooks/razorpay                  (raw body, unauthenticated, X-Razorpay-Signature)
 *
 * Checkout is naturally idempotent (one subscription row per account; a double-submit returns
 * the in-flight Razorpay subscription instead of creating a second one) and cancel is naturally
 * idempotent (a second call finds no non-terminal subscription and returns NOT_FOUND), so neither
 * needs the Idempotency-Key replay machinery M07/M28 use for money-adjacent but non-Razorpay-
 * backed writes.
 *
 * The app type is structural (as in M05/M07/M28), so a FastifyInstance satisfies it. The webhook
 * route needs the exact raw request bytes for HMAC verification (razorpay.ts); the host app must
 * preserve them on `req.rawBody` (e.g. a raw-body content-type parser scoped to this one route),
 * since Fastify's default JSON parser does not.
 */
import { AppError, log, toAppError, type ActorContext } from '../m01_platform/index.js';
import { applySessionCookies, requireMember, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { getInvoicePdf, invoiceDto, listInvoices } from './invoices.js';
import { isCycle, isPlanKey, plansDto } from './plans.js';
import { billingDetailsDto, cancelSubscription, checkout, getMyBillingDetails, parseBillingDetails, requestPaymentMethodUpdate, updateBillingDetails } from './subscriptions.js';
import { handleRazorpayWebhook } from './webhooks.js';

export interface BillingRouteRequest extends HttpRequestLike {
  body?: unknown;
  query?: unknown;
  params?: unknown;
  /** Only set on POST /webhooks/razorpay: the exact bytes Razorpay sent. */
  rawBody?: string | Buffer;
}

export interface BillingRouteReply extends HttpReplyLike {
  code(status: number): BillingRouteReply;
  send(payload?: unknown): unknown;
}

type RouteHandler = (req: BillingRouteRequest, reply: BillingRouteReply) => Promise<unknown>;

export interface BillingRouteApp {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
  put(path: string, handler: RouteHandler): unknown;
}

type Handler = (req: BillingRouteRequest, ctx: ActorContext) => Promise<{ status: number; body?: unknown }>;

function wrap(name: string, requireAuth: boolean, fn: Handler): RouteHandler {
  return async (req, reply) => {
    let correlationId: string | undefined;
    try {
      const ctx = await resolveSession(req);
      correlationId = ctx.correlationId;
      if (requireAuth) requireMember(ctx);
      const out = await fn(req, ctx);
      applySessionCookies(req, reply);
      reply.code(out.status);
      return out.body === undefined ? reply.send() : reply.send(out.body);
    } catch (e) {
      const err = toAppError(e, correlationId);
      if (err.code === 'INTERNAL') log.error({ err: e, route: name, correlationId }, 'm36 billing route failed');
      applySessionCookies(req, reply);
      const retry = err.details?.retryAfterSec;
      if (err.code === 'RATE_LIMITED' && typeof retry === 'number') reply.header('retry-after', String(retry));
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  };
}

/** JSON body is validated field-by-field below, so a non-object body degrades to "no fields set"
 * rather than throwing here — the individual field checks (isPlanKey, isCycle, ...) then report
 * the actual validation error. */
function bodyRecord(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return Object.create(null) as Record<string, unknown>;
  }
  return v as Record<string, unknown>;
}

function paramId(req: BillingRouteRequest): string {
  let params: Record<string, unknown>;
  if (req.params !== null && req.params !== undefined && typeof req.params === 'object') {
    params = req.params as Record<string, unknown>;
  } else {
    params = Object.create(null) as Record<string, unknown>;
  }
  const id = params.id;
  if (typeof id !== 'string' || id.length === 0) throw new AppError('NOT_FOUND', 'Invoice not found');
  return id;
}

function rawBodyString(req: BillingRouteRequest): string {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  // Falls through to signature verification failing closed (400) rather than trusting a
  // re-serialised (and therefore signature-invalidating) JSON body.
  return typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
}

function headerString(req: BillingRouteRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function registerBillingRoutes(app: BillingRouteApp): void {
  app.get(
    '/api/plans',
    wrap('plans.get', false, async () => ({ status: 200, body: plansDto() })),
  );

  app.post(
    '/api/billing/checkout',
    wrap('billing.checkout', true, async (req, ctx) => {
      const b = bodyRecord(req.body);
      if (!isPlanKey(b.plan)) throw new AppError('VALIDATION', 'plan must be "starter" or "growth"', { field: 'plan' });
      if (!isCycle(b.cycle)) throw new AppError('VALIDATION', 'cycle must be "monthly" or "annual"', { field: 'cycle' });
      const result = await checkout(ctx, { plan: b.plan, cycle: b.cycle });
      return { status: 200, body: result };
    }),
  );

  app.post(
    '/api/billing/cancel',
    wrap('billing.cancel', true, async (req, ctx) => {
      const b = bodyRecord(req.body);
      const atPeriodEnd = b.atPeriodEnd !== false; // default true (LLD example body: {atPeriodEnd: true})
      const result = await cancelSubscription(ctx, { atPeriodEnd });
      return { status: 200, body: result };
    }),
  );

  app.post(
    '/api/billing/update-method',
    wrap('billing.update_method', true, async (_req, ctx) => ({ status: 200, body: await requestPaymentMethodUpdate(ctx) })),
  );

  app.put(
    '/api/billing/details',
    wrap('billing.details.put', true, async (req, ctx) => {
      const input = parseBillingDetails(req.body);
      const row = await updateBillingDetails(ctx, input);
      return { status: 200, body: billingDetailsDto(row) };
    }),
  );

  app.get(
    '/api/billing/details',
    wrap('billing.details.get', true, async (_req, ctx) => {
      const row = await getMyBillingDetails(ctx);
      if (!row) throw new AppError('NOT_FOUND', 'Billing details not set');
      return { status: 200, body: billingDetailsDto(row) };
    }),
  );

  app.get(
    '/api/invoices',
    wrap('invoices.list', true, async (_req, ctx) => {
      const items = await listInvoices(ctx);
      return { status: 200, body: { items: items.map(invoiceDto) } };
    }),
  );

  app.get(
    '/api/invoices/:id/pdf',
    wrap('invoices.pdf', true, async (req, ctx) => {
      const { body } = await getInvoicePdf(ctx, paramId(req));
      // The generic `wrap()` always calls reply.send(body); Buffer/Uint8Array bodies stream as
      // binary under Fastify's default reply serialisation, so no special-casing is needed here
      // beyond returning the raw bytes. Content-Type is best set by the host app's route options
      // (application/pdf) since BillingRouteReply's structural type has no `.type()` method.
      return { status: 200, body };
    }),
  );

  // Not routed through wrap(): unauthenticated, needs the raw body, and must never set session
  // cookies on a server-to-server callback.
  app.post('/webhooks/razorpay', async (req, reply) => {
    const result = await handleRazorpayWebhook(rawBodyString(req), headerString(req, 'x-razorpay-signature'), headerString(req, 'x-razorpay-event-id'));
    reply.code(result.status);
    return reply.send(result.body);
  });
}
