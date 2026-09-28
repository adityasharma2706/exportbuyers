/**
 * M36 — persistence for serving.subscription, serving.payment, serving.invoice,
 * serving.billing_details, serving.invoice_seq, serving.webhook_event and
 * serving.billing_mismatch (LLD M36 "Schema"). Account-scoped tables are registered with M01's
 * TenantTable registry so RLS applies underneath, even though every write here goes through raw
 * SQL (the double-entry-style upserts need ON CONFLICT / RETURNING that the generic ScopedDb
 * builders do not expose — the same rationale as M28's ledger.ts).
 *
 * serving.webhook_event, serving.invoice_seq and serving.billing_mismatch are never touched
 * through scoped(ctx) (there is no request actor for a webhook or a background job), so they are
 * not registered as tenant tables; access is always through systemExec().
 */
import { sql } from 'kysely';
import { registerTenantTable } from '../m01_platform/index.js';
import type { Exec } from './exec.js';
import type {
  BillingDetailsRow,
  BillingMismatchInput,
  Cycle,
  InvoiceRow,
  PaymentRow,
  PaymentStatus,
  PlanKey,
  SubscriptionRow,
  SubscriptionStatus,
  WebhookEventRow,
} from './types.js';

registerTenantTable('serving.subscription', 'account');
registerTenantTable('serving.payment', 'account');
registerTenantTable('serving.invoice', 'account');
registerTenantTable('serving.billing_details', 'account');

// ---- tenant row shapes (declaration merging into M01's TenantTableRows) --------------------

export interface SubscriptionDbRow {
  id: string;
  account_id: string;
  plan: PlanKey;
  cycle: Cycle;
  razorpay_sub_id: string | null;
  status: SubscriptionStatus;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PaymentDbRow {
  id: string;
  account_id: string;
  razorpay_payment_id: string;
  amount_paise: number;
  status: PaymentStatus;
  invoice_id: string | null;
  created_at: Date;
}

export interface InvoiceDbRow {
  id: string;
  account_id: string;
  number: string;
  gstin: string | null;
  place_of_supply: string;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  pdf_s3_key: string | null;
  issued_at: Date;
}

export interface BillingDetailsDbRow {
  account_id: string;
  legal_name: string;
  gstin: string | null;
  state_code: string;
  address: string;
  updated_at: Date;
}

declare module '../m01_platform/tenancy.js' {
  interface TenantTableRows {
    'serving.subscription': SubscriptionDbRow;
    'serving.payment': PaymentDbRow;
    'serving.invoice': InvoiceDbRow;
    'serving.billing_details': BillingDetailsDbRow;
  }
}

// ---- mapping ---------------------------------------------------------------------------------

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toDateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : toDate(v);
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function mapSubscription(r: Record<string, unknown>): SubscriptionRow {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    plan: String(r.plan) as PlanKey,
    cycle: String(r.cycle) as Cycle,
    razorpaySubId: strOrNull(r.razorpay_sub_id),
    status: String(r.status) as SubscriptionStatus,
    currentPeriodStart: toDateOrNull(r.current_period_start),
    currentPeriodEnd: toDateOrNull(r.current_period_end),
    cancelAtPeriodEnd: r.cancel_at_period_end === true,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

export function mapPayment(r: Record<string, unknown>): PaymentRow {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    razorpayPaymentId: String(r.razorpay_payment_id),
    amountPaise: Number(r.amount_paise),
    status: String(r.status) as PaymentStatus,
    invoiceId: strOrNull(r.invoice_id),
    createdAt: toDate(r.created_at),
  };
}

export function mapInvoice(r: Record<string, unknown>): InvoiceRow {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    number: String(r.number),
    gstin: strOrNull(r.gstin),
    placeOfSupply: String(r.place_of_supply),
    taxablePaise: Number(r.taxable_paise),
    cgstPaise: Number(r.cgst_paise),
    sgstPaise: Number(r.sgst_paise),
    igstPaise: Number(r.igst_paise),
    pdfS3Key: strOrNull(r.pdf_s3_key),
    issuedAt: toDate(r.issued_at),
  };
}

export function mapBillingDetails(r: Record<string, unknown>): BillingDetailsRow {
  return {
    accountId: String(r.account_id),
    legalName: String(r.legal_name),
    gstin: strOrNull(r.gstin),
    stateCode: String(r.state_code),
    address: String(r.address),
    updatedAt: toDate(r.updated_at),
  };
}

function mapWebhookEvent(r: Record<string, unknown>): WebhookEventRow {
  return {
    razorpayEventId: String(r.razorpay_event_id),
    type: String(r.type),
    payload: r.payload,
    receivedAt: toDate(r.received_at),
    processedAt: toDateOrNull(r.processed_at),
  };
}

// ---- subscription -----------------------------------------------------------------------------

export async function findSubscriptionByAccount(exec: Exec, accountId: string): Promise<SubscriptionRow | null> {
  const rows = await exec.run(sql<Record<string, unknown>>`select * from serving.subscription where account_id = ${accountId}`);
  return rows.length > 0 ? mapSubscription(rows[0]!) : null;
}

export async function findSubscriptionByRazorpayId(exec: Exec, razorpaySubId: string): Promise<SubscriptionRow | null> {
  const rows = await exec.run(sql<Record<string, unknown>>`select * from serving.subscription where razorpay_sub_id = ${razorpaySubId}`);
  return rows.length > 0 ? mapSubscription(rows[0]!) : null;
}

export interface InsertSubscriptionInput {
  id: string;
  accountId: string;
  plan: PlanKey;
  cycle: Cycle;
  razorpaySubId: string;
  status: SubscriptionStatus;
}

/** First checkout for an account, or a fresh checkout after a terminal (cancelled/completed)
 * subscription: replaces the row and resets cancel_at_period_end. */
export async function upsertFreshSubscription(exec: Exec, row: InsertSubscriptionInput): Promise<SubscriptionRow> {
  const rows = await exec.run(sql<Record<string, unknown>>`
    insert into serving.subscription
      (id, account_id, plan, cycle, razorpay_sub_id, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
    values
      (${row.id}, ${row.accountId}, ${row.plan}, ${row.cycle}, ${row.razorpaySubId}, ${row.status}, null, null, false, now(), now())
    on conflict (account_id) do update set
      plan = excluded.plan,
      cycle = excluded.cycle,
      razorpay_sub_id = excluded.razorpay_sub_id,
      status = excluded.status,
      current_period_start = null,
      current_period_end = null,
      cancel_at_period_end = false,
      updated_at = now()
    returning *
  `);
  return mapSubscription(rows[0]!);
}

export interface WebhookSubscriptionUpdate {
  accountId: string;
  razorpaySubId: string;
  plan: PlanKey;
  cycle: Cycle;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

/** Applies a Razorpay subscription webhook's state to our row. Inserts a row if the account has
 * none yet (should not normally happen — checkout always creates one first — but keeps the
 * handler correct if a webhook is ever delivered before its own checkout response is recorded).
 * Never touches cancel_at_period_end: that is only ever set by the self-service cancel() call. */
export async function upsertSubscriptionFromWebhook(exec: Exec, u: WebhookSubscriptionUpdate, newId: string): Promise<SubscriptionRow> {
  const rows = await exec.run(sql<Record<string, unknown>>`
    insert into serving.subscription
      (id, account_id, plan, cycle, razorpay_sub_id, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
    values
      (${newId}, ${u.accountId}, ${u.plan}, ${u.cycle}, ${u.razorpaySubId}, ${u.status}, ${u.currentPeriodStart}, ${u.currentPeriodEnd}, false, now(), now())
    on conflict (account_id) do update set
      plan = excluded.plan,
      cycle = excluded.cycle,
      razorpay_sub_id = excluded.razorpay_sub_id,
      status = excluded.status,
      current_period_start = coalesce(excluded.current_period_start, serving.subscription.current_period_start),
      current_period_end = coalesce(excluded.current_period_end, serving.subscription.current_period_end),
      updated_at = now()
    returning *
  `);
  return mapSubscription(rows[0]!);
}

export async function setCancelAtPeriodEnd(exec: Exec, accountId: string, value: boolean): Promise<void> {
  await exec.run(sql`update serving.subscription set cancel_at_period_end = ${value}, updated_at = now() where account_id = ${accountId}`);
}

export async function setSubscriptionCancelledNow(exec: Exec, accountId: string, now: Date): Promise<void> {
  await exec.run(sql`
    update serving.subscription
    set status = 'cancelled', cancel_at_period_end = false, current_period_end = ${now}, updated_at = now()
    where account_id = ${accountId}
  `);
}

/** For the reconciliation job: subscriptions with a live Razorpay id, touched recently. */
export async function listRecentlyTouchedSubscriptions(exec: Exec, sinceHours: number, limit: number): Promise<SubscriptionRow[]> {
  const rows = await exec.run(sql<Record<string, unknown>>`
    select * from serving.subscription
    where razorpay_sub_id is not null and updated_at >= now() - (${sinceHours} || ' hours')::interval
    order by updated_at asc
    limit ${limit}
  `);
  return rows.map(mapSubscription);
}

// ---- payment ------------------------------------------------------------------------------

export interface InsertPaymentInput {
  id: string;
  accountId: string;
  razorpayPaymentId: string;
  amountPaise: number;
  status: PaymentStatus;
}

/** Idempotent on razorpay_payment_id. Returns the row and whether it was newly inserted. */
export async function insertPaymentIfNew(exec: Exec, p: InsertPaymentInput): Promise<{ row: PaymentRow; created: boolean }> {
  const inserted = await exec.run(sql<Record<string, unknown>>`
    insert into serving.payment (id, account_id, razorpay_payment_id, amount_paise, status, invoice_id, created_at)
    values (${p.id}, ${p.accountId}, ${p.razorpayPaymentId}, ${p.amountPaise}, ${p.status}, null, now())
    on conflict (razorpay_payment_id) do nothing
    returning *
  `);
  if (inserted.length > 0) return { row: mapPayment(inserted[0]!), created: true };
  const existing = await exec.run(sql<Record<string, unknown>>`select * from serving.payment where razorpay_payment_id = ${p.razorpayPaymentId}`);
  return { row: mapPayment(existing[0]!), created: false };
}

export async function setPaymentInvoiceId(exec: Exec, paymentId: string, invoiceId: string): Promise<void> {
  await exec.run(sql`update serving.payment set invoice_id = ${invoiceId} where id = ${paymentId}`);
}

// ---- invoice ------------------------------------------------------------------------------

export interface InsertInvoiceInput {
  id: string;
  accountId: string;
  number: string;
  gstin: string | null;
  placeOfSupply: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  pdfS3Key: string;
}

export async function insertInvoice(exec: Exec, i: InsertInvoiceInput): Promise<InvoiceRow> {
  const rows = await exec.run(sql<Record<string, unknown>>`
    insert into serving.invoice
      (id, account_id, number, gstin, place_of_supply, taxable_paise, cgst_paise, sgst_paise, igst_paise, pdf_s3_key, issued_at)
    values
      (${i.id}, ${i.accountId}, ${i.number}, ${i.gstin}, ${i.placeOfSupply}, ${i.taxablePaise}, ${i.cgstPaise}, ${i.sgstPaise}, ${i.igstPaise}, ${i.pdfS3Key}, now())
    returning *
  `);
  return mapInvoice(rows[0]!);
}

export async function listInvoices(exec: Exec, accountId: string, limit = 200): Promise<InvoiceRow[]> {
  const rows = await exec.run(sql<Record<string, unknown>>`
    select * from serving.invoice where account_id = ${accountId} order by issued_at desc limit ${limit}
  `);
  return rows.map(mapInvoice);
}

export async function getInvoiceById(exec: Exec, accountId: string, id: string): Promise<InvoiceRow | null> {
  const rows = await exec.run(sql<Record<string, unknown>>`select * from serving.invoice where id = ${id} and account_id = ${accountId}`);
  return rows.length > 0 ? mapInvoice(rows[0]!) : null;
}

/**
 * Atomic per-financial-year counter ('INV/FY26-27/000123'). Two statements rather than a single
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, because distinguishing the insert path from
 * the update path in one RETURNING relies on an undocumented Postgres implementation detail
 * (`xmax = 0`); the plain UPDATE below is unambiguous and still atomic — the row lock it takes
 * serialises concurrent callers for the same `fy`. Must run inside the caller's transaction (it
 * does: invoices.ts calls this from the same tx that inserts the serving.invoice row).
 */
export async function nextInvoiceNumber(exec: Exec, fy: string): Promise<number> {
  await exec.run(sql`insert into serving.invoice_seq (fy, next_number) values (${fy}, 1) on conflict (fy) do nothing`);
  const rows = await exec.run(sql<{ n: number | string }>`
    update serving.invoice_seq set next_number = next_number + 1 where fy = ${fy} returning next_number - 1 as n
  `);
  return Number(rows[0]!.n);
}

// ---- billing details ------------------------------------------------------------------------

export interface UpsertBillingDetailsInput {
  accountId: string;
  legalName: string;
  gstin: string | null;
  stateCode: string;
  address: string;
}

export async function upsertBillingDetails(exec: Exec, b: UpsertBillingDetailsInput): Promise<BillingDetailsRow> {
  const rows = await exec.run(sql<Record<string, unknown>>`
    insert into serving.billing_details (account_id, legal_name, gstin, state_code, address, updated_at)
    values (${b.accountId}, ${b.legalName}, ${b.gstin}, ${b.stateCode}, ${b.address}, now())
    on conflict (account_id) do update set
      legal_name = excluded.legal_name, gstin = excluded.gstin, state_code = excluded.state_code, address = excluded.address, updated_at = now()
    returning *
  `);
  return mapBillingDetails(rows[0]!);
}

export async function getBillingDetails(exec: Exec, accountId: string): Promise<BillingDetailsRow | null> {
  const rows = await exec.run(sql<Record<string, unknown>>`select * from serving.billing_details where account_id = ${accountId}`);
  return rows.length > 0 ? mapBillingDetails(rows[0]!) : null;
}

// ---- webhook_event (system-only; not a tenant table) -----------------------------------------

export async function insertWebhookEventIfNew(exec: Exec, e: { id: string; type: string; payloadJson: unknown }): Promise<boolean> {
  const rows = await exec.run(sql<{ razorpay_event_id: string }>`
    insert into serving.webhook_event (razorpay_event_id, type, payload, received_at)
    values (${e.id}, ${e.type}, ${JSON.stringify(e.payloadJson)}::jsonb, now())
    on conflict (razorpay_event_id) do nothing
    returning razorpay_event_id
  `);
  return rows.length > 0;
}

export async function getWebhookEvent(exec: Exec, id: string): Promise<WebhookEventRow | null> {
  const rows = await exec.run(sql<Record<string, unknown>>`select * from serving.webhook_event where razorpay_event_id = ${id}`);
  return rows.length > 0 ? mapWebhookEvent(rows[0]!) : null;
}

export async function markWebhookProcessed(exec: Exec, id: string): Promise<void> {
  await exec.run(sql`update serving.webhook_event set processed_at = now() where razorpay_event_id = ${id}`);
}

// ---- billing_mismatch (system-only; not a tenant table) ---------------------------------------

export async function insertBillingMismatch(exec: Exec, m: BillingMismatchInput): Promise<void> {
  await exec.run(sql`
    insert into serving.billing_mismatch (id, account_id, razorpay_sub_id, local_status, remote_status, detected_at, resolved)
    values (${m.id}, ${m.accountId}, ${m.razorpaySubId}, ${m.localStatus}, ${m.remoteStatus}, now(), false)
  `);
}
