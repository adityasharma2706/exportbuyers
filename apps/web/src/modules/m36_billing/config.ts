/**
 * M36 — tunables and secret names (LLD M36 Rules).
 */
export const SECRET_RAZORPAY_KEY_ID = 'RAZORPAY_KEY_ID';
export const SECRET_RAZORPAY_KEY_SECRET = 'RAZORPAY_KEY_SECRET';
export const SECRET_RAZORPAY_WEBHOOK_SECRET = 'RAZORPAY_WEBHOOK_SECRET';

export interface BillingConfig {
  /** Monthly-grant credits expire at `period_end + this many days` [tunable, 30]. */
  creditsExpiryGraceDays: number;
  /** Reconciliation job [tunable, 48]: how far back "recently touched" subscriptions are re-checked. */
  reconcileLookbackHours: number;
  /** Cap on subscriptions re-fetched from Razorpay per reconciliation run. */
  reconcileMaxSubscriptions: number;
  /** `total_count` billing cycles passed when creating a monthly UPI AutoPay subscription [tunable]. */
  monthlyTotalCount: number;
  /** `total_count` billing cycles passed when creating an annual subscription [tunable]. */
  annualTotalCount: number;
  /** Combined GST rate applied to (GST-inclusive) subscription prices [tunable, 18]. */
  gstRatePct: number;
  /** Seller's GST home state code; decides CGST+SGST (intra-state) vs IGST (inter-state) [tunable]. */
  supplierStateCode: string;
  supplierLegalName: string;
  supplierGstin: string;
  supplierAddress: string;
  razorpayApiBase: string;
  razorpayHttpTimeoutMs: number;
}

const DEFAULTS: BillingConfig = Object.freeze({
  creditsExpiryGraceDays: 30,
  reconcileLookbackHours: 48,
  reconcileMaxSubscriptions: 2000,
  monthlyTotalCount: 120,
  annualTotalCount: 10,
  gstRatePct: 18,
  // [tunable] unset-marker defaults, replaced once the registered GST details are supplied via
  // env in staging and production. '00' is not a real GST state code (it passes the DB's 2-digit
  // format check, but no such state exists) — invoices.ts refuses to issue an invoice while it is
  // still set, so a misconfigured deployment fails loudly (INTERNAL) instead of silently issuing
  // a bogus invoice.
  supplierStateCode: '00',
  supplierLegalName: 'ExportBuyers Technologies Private Limited',
  supplierGstin: '',
  supplierAddress: 'Registered office address not configured',
  razorpayApiBase: 'https://api.razorpay.com/v1',
  razorpayHttpTimeoutMs: 10_000,
});

let current: BillingConfig = { ...DEFAULTS };

function positiveInt(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

function str(v: string | undefined, fallback: string): string {
  return v !== undefined && v.trim() !== '' ? v : fallback;
}

export function loadBillingConfig(env: Record<string, string | undefined> = process.env): BillingConfig {
  current = {
    creditsExpiryGraceDays: positiveInt(env.M36_CREDITS_EXPIRY_GRACE_DAYS, DEFAULTS.creditsExpiryGraceDays),
    reconcileLookbackHours: positiveInt(env.M36_RECONCILE_LOOKBACK_HOURS, DEFAULTS.reconcileLookbackHours),
    reconcileMaxSubscriptions: positiveInt(env.M36_RECONCILE_MAX_SUBSCRIPTIONS, DEFAULTS.reconcileMaxSubscriptions),
    monthlyTotalCount: positiveInt(env.M36_MONTHLY_TOTAL_COUNT, DEFAULTS.monthlyTotalCount),
    annualTotalCount: positiveInt(env.M36_ANNUAL_TOTAL_COUNT, DEFAULTS.annualTotalCount),
    gstRatePct: positiveInt(env.M36_GST_RATE_PCT, DEFAULTS.gstRatePct),
    supplierStateCode: str(env.M36_SUPPLIER_STATE_CODE, DEFAULTS.supplierStateCode),
    supplierLegalName: str(env.M36_SUPPLIER_LEGAL_NAME, DEFAULTS.supplierLegalName),
    supplierGstin: str(env.M36_SUPPLIER_GSTIN, DEFAULTS.supplierGstin),
    supplierAddress: str(env.M36_SUPPLIER_ADDRESS, DEFAULTS.supplierAddress),
    razorpayApiBase: str(env.M36_RAZORPAY_API_BASE, DEFAULTS.razorpayApiBase),
    razorpayHttpTimeoutMs: positiveInt(env.M36_RAZORPAY_HTTP_TIMEOUT_MS, DEFAULTS.razorpayHttpTimeoutMs),
  };
  return current;
}

export function billingConfig(): BillingConfig {
  return current;
}

/** For tests. */
export function setBillingConfig(patch: Partial<BillingConfig>): void {
  current = { ...current, ...patch };
}
