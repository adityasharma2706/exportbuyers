/**
 * M05 — passwordless OTP by SMS (DLT template) and email (IF-05a). REQ-001.
 *
 * Rules (LLD M05):
 *  - 6 digits, stored as hmac_sha256(pepper, code), valid 10 minutes, at most 5 verify attempts.
 *  - Requests: 3 per destination per 15 min and 10 per IP per hour (Redis sliding windows),
 *    plus one per destination per resendAfterSec (30 s). Exceeding any → RATE_LIMITED.
 *  - SMS: E.164 and +91 only at launch; otherwise VALIDATION suggesting email.
 *  - Verify finds or creates the member, rotates the session id and carries anonymous work
 *    into anon_state_pending.
 *
 * The challenge row stores only a hash of the destination. The destination itself is kept,
 * encrypted, in Redis for the challenge's lifetime so the verify step can find or create the
 * member without the client sending it again.
 */
import { AppError, getRedis, log, newId, rateLimited, type ActorContext } from '../m01_platform/index.js';
import { identityConfig } from './config.js';
import { decrypt, encrypt, generateOtpCode, hashDestination, hashOtpCode, keyHash, safeEqualHex } from './crypto.js';
import { rateStore } from './rateLimit.js';
import { consumeChallenge, countVerifyAttempt, findOrCreateMember, getChallenge, insertChallenge } from './repo.js';
import { clientIp, requestMetaOf, startMemberSession, type HttpRequestLike } from './session.js';
import { normaliseDestination, parseOtpRequest, parseOtpVerify, type OtpChannel } from './validate.js';
import { isRetryableVendorError, sendSms, sendTransactionalEmail } from './vendors.js';

export const OTP_EMAIL_TEMPLATE = 'auth_otp';

const destKey = (challengeId: string): string => `m05:otp:dest:${challengeId}`;

export interface OtpRequestResult {
  challengeId: string;
  resendAfterSec: number;
}

export interface OtpVerifyResult {
  isNewUser: boolean;
}

function otherChannel(c: OtpChannel): OtpChannel {
  return c === 'sms' ? 'email' : 'sms';
}

/** POST /api/auth/otp/request */
export async function requestOtp(req: HttpRequestLike, body: unknown): Promise<OtpRequestResult> {
  const cfg = identityConfig().otp;
  const { channel, destination } = parseOtpRequest(body);
  const dest = normaliseDestination(channel, destination);
  const destHash = hashDestination(channel, dest);
  const ip = clientIp(req);
  const now = new Date();

  const limits = await rateStore().hit(
    [
      { key: `m05:otp:resend:${destHash}`, limit: 1, windowSec: cfg.resendAfterSec },
      { key: `m05:otp:dest:${destHash}`, limit: cfg.perDestination.limit, windowSec: cfg.perDestination.windowSec },
      { key: `m05:otp:ip:${keyHash('ip', ip)}`, limit: cfg.perIp.limit, windowSec: cfg.perIp.windowSec },
    ],
    now.getTime(),
    true,
  );
  if (!limits.allowed) {
    const scope = (['resend', 'destination', 'ip'] as const)[limits.blockedBy] ?? 'destination';
    throw rateLimited(limits.retryAfterSec, 'Too many code requests; please wait', { scope });
  }

  const challengeId = newId<'otp_challenge'>();
  const code = generateOtpCode(cfg.digits);
  const expiresAt = new Date(now.getTime() + cfg.ttlSec * 1000);
  await insertChallenge({ id: challengeId, channel, destinationHash: destHash, codeHash: hashOtpCode(code), expiresAt, ip, now });
  await getRedis().set(
    destKey(challengeId),
    encrypt(Buffer.from(JSON.stringify({ channel, dest }), 'utf8'), destKey(challengeId)).toString('base64'),
    'EX',
    cfg.ttlSec,
  );

  try {
    if (channel === 'sms') {
      const tpl = identityConfig().vendors.smsOtpDltTemplateId;
      if (!tpl) throw new AppError('UPSTREAM_UNAVAILABLE', 'SMS sign-in is not configured', { vendor: 'sms', retryable: false });
      await sendSms(dest, tpl, [code, String(Math.round(cfg.ttlSec / 60))]);
    } else {
      // No idempotencyKey: an OTP must be delivered now or the user switches channel.
      await sendTransactionalEmail(dest, OTP_EMAIL_TEMPLATE, { code, validMinutes: Math.round(cfg.ttlSec / 60) });
    }
  } catch (e) {
    await consumeChallenge(challengeId, new Date()).catch(() => undefined);
    await getRedis().del(destKey(challengeId)).catch(() => 0);
    if (e instanceof AppError && e.code === 'UPSTREAM_UNAVAILABLE') {
      log.warn({ err: e, channel }, 'OTP delivery failed');
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not send the code; try the other option', {
        channel,
        alternateChannel: otherChannel(channel),
        retryable: isRetryableVendorError(e),
      });
    }
    throw e;
  }
  log.info({ challengeId, channel }, 'otp issued');
  return { challengeId, resendAfterSec: cfg.resendAfterSec };
}

function expired(): AppError {
  return new AppError('VALIDATION', 'This code has expired; request a new one', { expired: true, attemptsLeft: 0 });
}

/** POST /api/auth/otp/verify — on success the caller writes the queued Set-Cookie. */
export async function verifyOtp(req: HttpRequestLike, ctx: ActorContext, body: unknown): Promise<OtpVerifyResult> {
  const cfg = identityConfig().otp;
  const { challengeId, code } = parseOtpVerify(body);
  const now = new Date();

  const row = await countVerifyAttempt(challengeId, cfg.maxVerifyAttempts, now);
  if (!row) {
    const existing = await getChallenge(challengeId);
    if (existing && existing.consumed_at === null && existing.expires_at > now && existing.attempts >= cfg.maxVerifyAttempts) {
      throw new AppError('VALIDATION', 'Too many wrong codes; request a new one', { attemptsLeft: 0, expired: true });
    }
    throw expired();
  }

  if (!safeEqualHex(hashOtpCode(code), row.code_hash)) {
    const attemptsLeft = Math.max(0, cfg.maxVerifyAttempts - row.attempts);
    throw new AppError('VALIDATION', 'Incorrect code', { attemptsLeft, ...(attemptsLeft === 0 ? { expired: true } : {}) });
  }

  if (!(await consumeChallenge(row.id, now))) throw expired();

  const raw = await getRedis().get(destKey(row.id));
  await getRedis().del(destKey(row.id)).catch(() => 0);
  if (raw === null) throw expired();
  let pending: { channel: OtpChannel; dest: string };
  try {
    pending = JSON.parse(decrypt(Buffer.from(raw, 'base64'), destKey(row.id)).toString('utf8')) as { channel: OtpChannel; dest: string };
  } catch (e) {
    throw new AppError('INTERNAL', 'OTP destination record is unreadable', undefined, { cause: e });
  }
  if (pending.channel !== row.channel || hashDestination(pending.channel, pending.dest) !== row.destination_hash) {
    throw new AppError('INTERNAL', 'OTP destination record does not match the challenge');
  }

  const { member, accountStatus, isNew } = await findOrCreateMember(pending.channel, pending.dest);
  if (accountStatus !== 'active' || member.erased_at !== null) {
    throw new AppError('FORBIDDEN', 'This account is closed', { accountStatus });
  }

  const meta = requestMetaOf(ctx);
  await startMemberSession(req, member, meta?.session ?? null);
  log.info({ memberId: member.id, isNew, channel: row.channel }, 'otp sign-in');
  return { isNewUser: isNew };
}
