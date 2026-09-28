/**
 * M30 Reports and automatic invalid-contact refunds — shared types (LLD M30 "Schema" / "API").
 */

export type ReportReason = 'wrong_product' | 'not_buyer' | 'closed' | 'invalid_contact' | 'suspicious';
export const REPORT_REASONS: readonly ReportReason[] = ['wrong_product', 'not_buyer', 'closed', 'invalid_contact', 'suspicious'];

/** Reasons that go to M11's `report.content` review type (LLD M30 Rules). */
export const CONTENT_REPORT_REASONS: readonly ReportReason[] = ['wrong_product', 'not_buyer', 'closed', 'suspicious'];

export type ReportState = 'open' | 'reverifying' | 'refunded' | 'review' | 'closed';
export const REPORT_STATES: readonly ReportState[] = ['open', 'reverifying', 'refunded', 'review', 'closed'];

export type HideTargetKind = 'company' | 'assertion';
export const HIDE_TARGET_KINDS: readonly HideTargetKind[] = ['company', 'assertion'];

export type RefundKind = 'confirmed' | 'unconfirmed';

/** serving.report row shape. */
export interface ReportRow {
  id: string;
  account_id: string;
  company_id: string;
  assertion_id: string | null;
  reason: ReportReason;
  note: string | null;
  reveal_id: string | null;
  state: ReportState;
  review_item_id: string | null;
  refund_kind: RefundKind | null;
  refund_period: string | null;
  refund_credits: number | null;
  refund_entry_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** serving.user_hide row shape. */
export interface UserHideRow {
  account_id: string;
  target_kind: HideTargetKind;
  target_id: string;
  created_at: Date;
}

// ---- IF-30a wire DTOs ---------------------------------------------------------------------------

export interface CreateReportRequest {
  companyId: string;
  assertionId?: string;
  reason: ReportReason;
  note?: string;
}

export type RefundStatus = 'pending' | 'not_applicable';

export interface CreateReportResponseDto {
  reportId: string;
  hidden: true;
  refundStatus: RefundStatus;
}

// ---- EV-06 payloads (py/kp/m25_freshness/models.py ContactVerifiedEvent / ContactInvalidatedEvent) --

export type ReverifyTrigger = 'reveal' | 'report' | 'schedule';

export interface ContactInvalidatedPayload {
  assertionId: string;
  companyId: string;
  kind: string;
  trigger: ReverifyTrigger;
  triggerRef: string;
}

export interface ContactVerifiedPayload extends ContactInvalidatedPayload {
  status: 'valid' | 'risky';
}

// ---- EV-13 report.filed ---------------------------------------------------------------------

export interface ReportFiledEvent {
  v: 1;
  reportId: string;
  accountId: string;
  companyId: string;
  assertionId: string | null;
  reason: ReportReason;
}

// ---- M11 'report.content' review type ---------------------------------------------------------

export interface ReportContentPayload {
  companyId: string;
  reason: ReportReason;
  /** The company's primary HS heading at filing time, used for `report_not_buyer {hs_heading}`. */
  hsHeading: string | null;
  /** Best-effort count of distinct reports collapsed into this item (LLD: "a counter in the payload"). */
  count: number;
}

export type ReportContentOutcome = 'apply' | 'dismiss';

// ---- M11 'report.refund_exception' review type -------------------------------------------------

export interface RefundExceptionPayload {
  reportId: string;
  accountId: string;
  companyId: string;
  assertionId: string;
  revealId: string;
  commitEntryId: string;
  credits: number;
  period: string;
  /** Why this went to review instead of an automatic refund. */
  exceptionReason: 'monthly_cap_exceeded';
}

export type RefundExceptionOutcome = 'approve' | 'deny';
