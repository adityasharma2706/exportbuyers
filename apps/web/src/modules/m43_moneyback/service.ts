/**
 * M43 — core service (IF-43a): `POST /api/billing/money-back {reason}`.
 *
 * LLD M43: "Eligible only for the first paid payment, and only within money_back_days = 7
 * [tunable]. Otherwise -> FORBIDDEN {reasonKey}." then "Files billing.money_back (dedupe per
 * payment)".
 */
import { z } from 'zod';
import { AppError, log, systemDb, withSpan, type ActorContext } from '../m01_platform/index.js';
import { requireMember } from '../m05_identity/index.js';
import type { Tx } from '../m02_queue/index.js';
import { file } from '../m11_review/index.js';
import { moneyBackConfig } from './config.js';
import { MONEY_BACK_TYPE } from './reviewType.js';
import { findFirstCapturedPayment, primaryEmailForAccount } from './repo.js';
import type { MoneyBackPayload, RequestMoneyBackResponseDto } from './types.js';

const MS_PER_DAY = 24 * 3_600_000;

const requestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

function parseRequest(raw: unknown): z.infer<typeof requestSchema> {
  const parsed = requestSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError('VALIDATION', 'Invalid money-back request', { issues: parsed.error.message });
  return parsed.data;
}

/** IF-43a `POST /api/billing/money-back`. */
export async function requestMoneyBack(ctx: ActorContext, rawBody: unknown): Promise<RequestMoneyBackResponseDto> {
  const { accountId } = requireMember(ctx);
  const body = parseRequest(rawBody);

  return withSpan('m43.requestMoneyBack', async () => {
    const payment = await findFirstCapturedPayment(ctx);
    if (!payment) {
      throw new AppError('FORBIDDEN', 'No paid payment is eligible for a money-back request', { reasonKey: 'no_paid_payment' });
    }

    const cfg = moneyBackConfig();
    const now = new Date();
    const ageDays = (now.getTime() - payment.createdAt.getTime()) / MS_PER_DAY;
    if (ageDays > cfg.windowDays) {
      throw new AppError('FORBIDDEN', 'The money-back window for this payment has closed', {
        reasonKey: 'window_expired',
        windowDays: cfg.windowDays,
      });
    }

    let requesterEmail: string | null = null;
    try {
      requesterEmail = await primaryEmailForAccount(accountId);
    } catch (err) {
      log.warn({ err, accountId }, 'm43: could not resolve the requester email; filing without one');
    }

    const payload: MoneyBackPayload = {
      accountId,
      paymentId: payment.id,
      razorpayPaymentId: payment.razorpayPaymentId,
      amountPaise: payment.amountPaise,
      reason: body.reason,
      requesterEmail,
      requestedAt: now.toISOString(),
    };

    const reviewItemId = await systemDb('m43: file a money-back request', ctx)
      .transaction()
      .execute(async (tx: Tx) =>
        file(tx, MONEY_BACK_TYPE, {
          subjectRefs: [
            { kind: 'account', id: accountId },
            { kind: 'payment', id: payment.id },
          ],
          payload,
          filedBy: { kind: 'user', ref: accountId },
          dedupeKey: payment.id,
        }),
      );

    return { reviewItemId, status: 'filed' as const };
  });
}
