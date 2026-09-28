/**
 * M36 — GST tax split and financial-year invoice numbering (LLD M36 "Other rules"):
 * "Invoice: IGST if the place of supply != the supplier's state, otherwise CGST+SGST at 9% each
 * (18% total). Invoice numbers come from a DB sequence, one per financial year."
 *
 * Subscription prices are treated as GST-inclusive (the standard Indian consumer-pricing
 * convention, and the only reading consistent with `amount_paise` coming straight off the
 * Razorpay payment): taxable value = amount / (1 + rate), tax = amount - taxable.
 */
import { billingConfig } from './config.js';

export interface TaxSplit {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

/** Indian financial year label for a date, e.g. 2026-09-28 -> "FY26-27" (1 Apr .. 31 Mar). */
export function financialYearLabel(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1..12
  const startYear = m >= 4 ? y : y - 1;
  const two = (n: number) => String(n % 100).padStart(2, '0');
  return `FY${two(startYear)}-${two(startYear + 1)}`;
}

export function invoiceNumber(fy: string, n: number): string {
  return `INV/${fy}/${String(n).padStart(6, '0')}`;
}

/**
 * Splits a GST-inclusive amount into taxable value + CGST/SGST or IGST, given the place of
 * supply's two-digit GST state code. Rounds each tax leg down to whole paise and folds any
 * rounding remainder into the first leg so the three tax components always sum exactly to
 * `amount - taxable`.
 */
export function splitTax(amountPaise: number, placeOfSupplyStateCode: string): TaxSplit {
  const cfg = billingConfig();
  const rate = cfg.gstRatePct / 100;
  const taxablePaise = Math.round(amountPaise / (1 + rate));
  const totalTaxPaise = amountPaise - taxablePaise;
  const interState = placeOfSupplyStateCode !== cfg.supplierStateCode;
  if (interState) {
    return { taxablePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: totalTaxPaise };
  }
  const half = Math.floor(totalTaxPaise / 2);
  const cgstPaise = half;
  const sgstPaise = totalTaxPaise - half; // absorbs an odd paise
  return { taxablePaise, cgstPaise, sgstPaise, igstPaise: 0 };
}
