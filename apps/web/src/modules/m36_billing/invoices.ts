/**
 * M36 — invoice creation (called from the `payment.captured` webhook handler in jobs.ts) and the
 * user-facing `GET /api/invoices` / `GET /api/invoices/:id/pdf` reads (LLD M36 "API").
 */
import { AppError, newId, objectStore, type ActorContext } from '../m01_platform/index.js';
import { billingConfig } from './config.js';
import { userExec, type Exec } from './exec.js';
import { financialYearLabel, invoiceNumber, splitTax } from './gst.js';
import { renderInvoicePdf } from './pdf.js';
import { getBillingDetails, getInvoiceById, insertInvoice, listInvoices as repoListInvoices, nextInvoiceNumber, setPaymentInvoiceId } from './repo.js';
import type { Cycle, InvoiceRow, PlanKey } from './types.js';

function pdfKey(accountId: string, invoiceId: string): string {
  return `billing/invoices/${accountId}/${invoiceId}.pdf`;
}

/**
 * Creates the invoice for a captured payment: computes the GST split (CGST+SGST or IGST) from
 * the account's billing details (falling back to the supplier's own state, i.e. intra-state, when
 * no billing details were captured), allocates the next per-financial-year invoice number, renders
 * the PDF, stores it in object storage and records the invoice row. Links it to the payment.
 * Runs inside the caller's transaction for the DB writes; the S3 write happens first so a failed
 * write aborts before any row is committed.
 */
export async function createInvoiceForPayment(
  exec: Exec,
  input: { accountId: string; paymentId: string; amountPaise: number; plan: PlanKey; cycle: Cycle },
): Promise<InvoiceRow> {
  const cfg = billingConfig();
  if (cfg.supplierStateCode === '00' || cfg.supplierGstin === '') {
    // Fail loudly rather than issue a GST-non-compliant invoice with an unregistered, made-up
    // seller GSTIN/state (LLD M36: "GST-compliant invoices"). The invoicing job (jobs.ts) retries
    // on its normal schedule once an operator sets M36_SUPPLIER_STATE_CODE / M36_SUPPLIER_GSTIN.
    throw new AppError('INTERNAL', 'M36 supplier GST details are not configured (M36_SUPPLIER_STATE_CODE / M36_SUPPLIER_GSTIN)');
  }
  const billing = await getBillingDetails(exec, input.accountId);
  const placeOfSupply = billing?.stateCode ?? cfg.supplierStateCode;
  const split = splitTax(input.amountPaise, placeOfSupply);

  const now = new Date();
  const fy = financialYearLabel(now);
  const n = await nextInvoiceNumber(exec, fy);
  const number = invoiceNumber(fy, n);
  const id = newId<'invoice'>();

  const pdf = await renderInvoicePdf({
    invoice: {
      id,
      accountId: input.accountId,
      number,
      gstin: billing?.gstin ?? null,
      placeOfSupply,
      taxablePaise: split.taxablePaise,
      cgstPaise: split.cgstPaise,
      sgstPaise: split.sgstPaise,
      igstPaise: split.igstPaise,
      pdfS3Key: null,
      issuedAt: now,
    },
    billing,
    plan: input.plan,
    cycle: input.cycle,
    amountPaise: input.amountPaise,
  });
  const key = pdfKey(input.accountId, id);
  await objectStore().put(key, pdf, 'application/pdf', { accountId: input.accountId, invoiceNumber: number });

  const invoice = await insertInvoice(exec, {
    id,
    accountId: input.accountId,
    number,
    gstin: billing?.gstin ?? null,
    placeOfSupply,
    taxablePaise: split.taxablePaise,
    cgstPaise: split.cgstPaise,
    sgstPaise: split.sgstPaise,
    igstPaise: split.igstPaise,
    pdfS3Key: key,
  });
  await setPaymentInvoiceId(exec, input.paymentId, invoice.id);
  return invoice;
}

/** IF-36 route: GET /api/invoices. */
export async function listInvoices(ctx: ActorContext): Promise<InvoiceRow[]> {
  const { exec, accountId } = userExec(ctx);
  return repoListInvoices(exec, accountId);
}

/** IF-36 route: GET /api/invoices/:id/pdf. */
export async function getInvoicePdf(ctx: ActorContext, invoiceId: string): Promise<{ invoice: InvoiceRow; body: Uint8Array }> {
  const { exec, accountId } = userExec(ctx);
  const invoice = await getInvoiceById(exec, accountId, invoiceId);
  if (!invoice || !invoice.pdfS3Key) throw new AppError('NOT_FOUND', 'Invoice not found');
  const obj = await objectStore().get(invoice.pdfS3Key);
  return { invoice, body: obj.body };
}

export function invoiceDto(i: InvoiceRow): Record<string, unknown> {
  return {
    id: i.id,
    number: i.number,
    gstin: i.gstin,
    placeOfSupply: i.placeOfSupply,
    taxablePaise: i.taxablePaise,
    cgstPaise: i.cgstPaise,
    sgstPaise: i.sgstPaise,
    igstPaise: i.igstPaise,
    totalPaise: i.taxablePaise + i.cgstPaise + i.sgstPaise + i.igstPaise,
    issuedAt: i.issuedAt.toISOString(),
  };
}
