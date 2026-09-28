/**
 * M30 — the refund decision (LLD M30 Rules, `invalid_contact` bullet). Shared by the EV-06
 * handlers (jobs.ts) and the reverify-timeout sweep (also jobs.ts), since both feed the same
 * state machine: a report sitting in `reverifying` is settled exactly once, either 'confirmed'
 * (M25 wrote ContactInvalidated: refund, no cap) or 'unconfirmed' (ContactVerified, or the 24 h
 * timeout: refund only under the monthly cap, else file `report.refund_exception`).
 */
import { log } from '../m01_platform/index.js';
import type { Tx } from '../m02_queue/index.js';
import { file } from '../m11_review/index.js';
import { istPeriod, refund } from '../m28_credits/index.js';
import { reportsConfig } from './config.js';
import {
  commitEntryCredits,
  countRevealContacts,
  getRevealCommitEntry,
  lockReportIfState,
  setReportRefunded,
  setReportReviewException,
  setReportState,
  tryConsumeRefundCap,
} from './repo.js';
import { REFUND_EXCEPTION_TYPE } from './reviewTypes.js';
import { SYSTEM_CTX } from './systemCtx.js';
import type { RefundExceptionPayload, RefundKind, ReportRow } from './types.js';

/**
 * `refund()` (M28 IF-28a) always runs in its own ledger transaction — M28's ledger operations are
 * never nested in a caller's tx (LLD M28 Rules: "Each operation runs in one tx that locks the
 * account row") — so the credit itself and `setReportRefunded` below (which does share `tx`, the
 * EV-06 handler's or the sweep's own transaction) are not atomically joined. This is safe because
 * `refund()` is idempotent on `idempotencyKey`: if `tx` later fails to commit for an unrelated
 * reason, the report simply stays `reverifying` and the next attempt (retry, or the timeout sweep)
 * calls `refund()` again with the same key and gets the same already-refunded entry back, rather
 * than crediting twice.
 */
async function doRefund(
  tx: Tx,
  report: ReportRow,
  credits: number,
  commitEntryId: string,
  kind: RefundKind,
  period: string | null,
): Promise<void> {
  const result = await refund(SYSTEM_CTX, {
    refersTo: commitEntryId,
    credits,
    reason:
      kind === 'confirmed'
        ? 'invalid_contact report: M25 confirmed the contact is invalid'
        : 'invalid_contact report: verified (or timed out); refunded under the monthly unconfirmed-refund cap',
    idempotencyKey: `refund:${report.reveal_id}:${report.assertion_id}`,
  });
  await setReportRefunded(tx, report.id, {
    refundKind: kind,
    refundPeriod: period,
    refundCredits: result.refunded,
    refundEntryId: result.refundEntryId,
  });
}

/**
 * Settles one `reverifying` report. Re-locks the row first (`for update`, only if it is still
 * `reverifying`) so a race between an EV-06 event and the timeout sweep settles it exactly once.
 * A no-op (returns without writing) if the report was already settled by the other path.
 */
export async function settleInvalidContactReport(tx: Tx, report: ReportRow, kind: RefundKind, now: Date = new Date()): Promise<void> {
  const locked = await lockReportIfState(tx, report.id, 'reverifying');
  if (!locked) return;

  if (!locked.reveal_id || !locked.assertion_id) {
    // No correlated reveal (LLD: "invalid_contact without a reveal -> no refund"), or a report
    // row that somehow reached `reverifying` without an assertion id: nothing to refund.
    await setReportState(tx, locked.id, 'closed');
    return;
  }

  const commitEntryId = await getRevealCommitEntry(tx, locked.reveal_id);
  if (!commitEntryId) {
    // The reveal was covered by the free allowance, not credits (LLD M29: commit_entry_id is
    // null in that case). There is nothing on the ledger to refund.
    await setReportState(tx, locked.id, 'closed');
    return;
  }
  const totalCommitted = await commitEntryCredits(tx, commitEntryId);
  if (totalCommitted === null) {
    log.error({ reportId: locked.id, commitEntryId }, 'm30: reveal has a commit_entry_id but no matching ledger.entry; closing without a refund');
    await setReportState(tx, locked.id, 'closed');
    return;
  }
  const contactCount = await countRevealContacts(tx, locked.reveal_id);
  // LLD M30: "credits = the per-contact share, rounded up to 1".
  const shareCredits = Math.max(1, Math.ceil(totalCommitted / contactCount));

  if (kind === 'confirmed') {
    await doRefund(tx, locked, shareCredits, commitEntryId, 'confirmed', null);
    return;
  }

  const period = istPeriod(now);
  const cap = reportsConfig().refundsUnconfirmedPerMonth;
  const capResult = await tryConsumeRefundCap(tx, locked.account_id, period, cap);
  if (capResult.allowed) {
    await doRefund(tx, locked, shareCredits, commitEntryId, 'unconfirmed', period);
    return;
  }

  const payload: RefundExceptionPayload = {
    reportId: locked.id,
    accountId: locked.account_id,
    companyId: locked.company_id,
    assertionId: locked.assertion_id,
    revealId: locked.reveal_id,
    commitEntryId,
    credits: shareCredits,
    period,
    exceptionReason: 'monthly_cap_exceeded',
  };
  const itemId = await file(tx, REFUND_EXCEPTION_TYPE, {
    subjectRefs: [
      { kind: 'report', id: locked.id },
      { kind: 'company', id: locked.company_id },
    ],
    payload,
    filedBy: { kind: 'system', ref: 'm30' },
    dedupeKey: `refund_exception:${locked.id}`,
  });
  await setReportReviewException(tx, locked.id, itemId);
}
