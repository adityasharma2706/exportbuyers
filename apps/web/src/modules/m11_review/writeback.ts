/**
 * M11 — write-back paths for outcome handlers.
 *
 * Review outcomes never write knowledge tables directly. They go through the owners' paths:
 *   - M09 IF-09b: an `m09.assertion_command` job on the knowledge queue (report_not_buyer,
 *     report_closed, operator_correction, merge_confirm, merge_reject, sanctions_decision);
 *   - M10 IF-10d: suppress(tx, entries, reason, reviewItemId), which emits EV-04 in the same tx.
 * Both are called with the EV-07 handler transaction, so the write-back commits exactly when
 * the handler succeeds.
 */
import { AppError, isUuid, type Id } from '../m01_platform/index.js';
import { enqueue, type Tx } from '../m02_queue/index.js';
import { suppress, type SuppressionEntry, type SuppressionReason } from '../m10_policy/index.js';
import type { ReviewItem } from './types.js';

/** IF-09b job type, handled by the Python knowledge plane (py/kp/m09_evidence). */
export const ASSERTION_COMMAND_JOB = 'm09.assertion_command';

export const ASSERTION_COMMAND_KINDS = [
  'report_not_buyer',
  'report_closed',
  'operator_correction',
  'merge_confirm',
  'merge_reject',
  'sanctions_decision',
] as const;
export type AssertionCommandKind = (typeof ASSERTION_COMMAND_KINDS)[number];

export interface AssertionCommandInput {
  kind: AssertionCommandKind;
  subjectId: string;
  payload?: Record<string, unknown>;
}

/** The actor string recorded on M09 commands: the resolving admin, else the M11 system actor. */
export function reviewActor(item: Pick<ReviewItem, 'resolvedBy'>): string {
  return item.resolvedBy ? `admin:${item.resolvedBy}` : 'system:m11';
}

/**
 * Enqueues an IF-09b AssertionCommand for a resolved review item, in `tx`. Idempotent per
 * (item, kind, subject), so a retried outcome handler does not issue a second command.
 */
export async function sendAssertionCommand(
  tx: Tx,
  item: Pick<ReviewItem, 'id' | 'resolvedBy'>,
  cmd: AssertionCommandInput,
): Promise<Id<'job'>> {
  if (!ASSERTION_COMMAND_KINDS.includes(cmd.kind)) {
    throw new AppError('VALIDATION', `Unknown assertion command kind "${String(cmd.kind)}"`);
  }
  if (!isUuid(cmd.subjectId)) throw new AppError('VALIDATION', 'Assertion command subjectId must be a uuid');
  const payload = cmd.payload ?? {};
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('VALIDATION', 'Assertion command payload must be an object');
  }
  return enqueue(tx, {
    type: ASSERTION_COMMAND_JOB,
    queue: 'knowledge',
    payload: {
      kind: cmd.kind,
      subject_id: cmd.subjectId,
      payload,
      review_item_id: item.id,
      actor: reviewActor(item),
    },
    idempotencyKey: `m11:${item.id}:${cmd.kind}:${cmd.subjectId}`,
  });
}

/**
 * Adds identifiers to the global suppression list for a review item (IF-10d), in `tx`. The
 * suppression rows carry the item id, and EV-04 purges the read models with no visibility window.
 */
export async function suppressFromReview(
  tx: Tx,
  item: Pick<ReviewItem, 'id'>,
  entries: ReadonlyArray<SuppressionEntry>,
  reason: SuppressionReason = 'removal_request',
): Promise<void> {
  await suppress(tx, entries, reason, item.id);
}
