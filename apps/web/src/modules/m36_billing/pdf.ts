/**
 * M36 — GST-compliant invoice PDF rendering (LLD M36 "Other rules": "Invoice... The PDF is
 * rendered from an HTML template [open: GST invoicing route]").
 *
 * [deviation: the LLD flags the exact rendering route as an open question and specifically names
 * an HTML template, which in practice means an HTML->PDF engine (a headless browser such as
 * Puppeteer/Playwright). That needs a bundled Chromium binary, which this sandboxed environment
 * cannot download or run, and is a heavy dependency for a background job that only needs to lay
 * out a one-page tax invoice. This renders the same invoice fields directly with `pdfkit` (a pure
 * Node PDF library, no native/browser dependency) instead. If the HTML-template route is chosen
 * later, only this file's renderInvoicePdf() needs to change — invoices.ts, the schema and the
 * public API are all independent of how the bytes are produced.]
 */
import PDFDocument from 'pdfkit';
import { billingConfig } from './config.js';
import type { BillingDetailsRow, InvoiceRow, PlanKey, Cycle } from './types.js';

export interface InvoicePdfInput {
  invoice: InvoiceRow;
  billing: BillingDetailsRow | null;
  plan: PlanKey;
  cycle: Cycle;
  amountPaise: number;
}

function inr(paise: number): string {
  return `Rs ${(paise / 100).toFixed(2)}`;
}

function line(doc: PDFDocument, label: string, value: string): void {
  doc.fontSize(10).fillColor('#000000').text(`${label}: `, { continued: true }).text(value);
}

/** Renders a one-page GST tax invoice and resolves with the PDF bytes. */
export function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const cfg = billingConfig();
  const { invoice, billing, plan, cycle, amountPaise } = input;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    // pdfkit's writable-stream interface does not model an 'error' event in the ambient
    // declaration above; a synchronous throw while building the document rejects instead.
    try {
      doc.fontSize(18).text('Tax Invoice', { align: 'center' });
      doc.moveDown(1);

      doc.fontSize(11).text('Supplier', { underline: true });
      line(doc, 'Legal name', cfg.supplierLegalName);
      if (cfg.supplierGstin) line(doc, 'GSTIN', cfg.supplierGstin);
      line(doc, 'State code', cfg.supplierStateCode);
      line(doc, 'Address', cfg.supplierAddress);
      doc.moveDown(1);

      doc.fontSize(11).text('Billed to', { underline: true });
      if (billing) {
        line(doc, 'Legal name', billing.legalName);
        if (billing.gstin) line(doc, 'GSTIN', billing.gstin);
        line(doc, 'State code', billing.stateCode);
        line(doc, 'Address', billing.address);
      } else {
        doc.fontSize(10).text('Billing details not provided at the time of purchase.');
      }
      doc.moveDown(1);

      doc.fontSize(11).text('Invoice', { underline: true });
      line(doc, 'Invoice number', invoice.number);
      line(doc, 'Issue date', invoice.issuedAt.toISOString().slice(0, 10));
      line(doc, 'Place of supply', invoice.placeOfSupply);
      doc.moveDown(1);

      doc.fontSize(11).text('Line items', { underline: true });
      doc.fontSize(10).text(`ExportBuyers ${plan[0]!.toUpperCase()}${plan.slice(1)} plan subscription (${cycle})`);
      doc.moveDown(0.5);

      line(doc, 'Taxable value', inr(invoice.taxablePaise));
      if (invoice.igstPaise > 0) {
        line(doc, `IGST (${cfg.gstRatePct}%)`, inr(invoice.igstPaise));
      } else {
        line(doc, `CGST (${cfg.gstRatePct / 2}%)`, inr(invoice.cgstPaise));
        line(doc, `SGST (${cfg.gstRatePct / 2}%)`, inr(invoice.sgstPaise));
      }
      doc.moveDown(0.5);
      doc.fontSize(12).text(`Total (GST-inclusive): ${inr(amountPaise)}`);

      doc.moveDown(2);
      doc.fontSize(8).fillColor('#555555').text('This is a system-generated tax invoice and does not require a signature.');

      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}
