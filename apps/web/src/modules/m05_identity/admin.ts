/**
 * M05 — admin role model and MFA (TOTP, RFC 6238).
 *
 * /admin/* routes need is_admin and mfa_verified; admin sessions last at most 12 hours.
 * Until MFA is verified an admin member acts as an ordinary user (kind='user'), so M01's
 * systemDb() and every admin-only check refuse them.
 */
import { AppError, getRedis, log, rateLimited, type ActorContext, type ActorRole } from '../m01_platform/index.js';
import { identityConfig } from './config.js';
import { base32Encode, decrypt, encrypt, newTotpSecret, verifyTotp } from './crypto.js';
import { rateStore } from './rateLimit.js';
import { getMember, setSessionMfaVerified, setTotpSecret } from './repo.js';
import { requestMetaOf, requireMember } from './session.js';
import { parseMfaVerify } from './validate.js';
import type { AdminRole } from './repo.js';

const totpAad = (memberId: string): string => `m05:totp:${memberId}`;

const ADMIN_ROLE_RANK: Readonly<Record<AdminRole, number>> = { admin_support: 1, admin_ops: 2, admin_super: 3 };

function isAdminRole(r: ActorRole | undefined): r is AdminRole {
  return r === 'admin_support' || r === 'admin_ops' || r === 'admin_super';
}

/**
 * Guard for /admin/* routes. Throws UNAUTHENTICATED for visitors, FORBIDDEN for non-admins
 * or admins without verified MFA (details.mfaRequired=true), or an insufficient admin role.
 */
export function requireAdmin(ctx: ActorContext, minRole: AdminRole = 'admin_support'): AdminRole {
  if (ctx.kind === 'anonymous') throw new AppError('UNAUTHENTICATED', 'Sign in required');
  const meta = requestMetaOf(ctx);
  if (ctx.kind !== 'admin') {
    if (meta?.member?.is_admin) throw new AppError('FORBIDDEN', 'Admin MFA required', { mfaRequired: true });
    throw new AppError('FORBIDDEN', 'Admin access required');
  }
  if (!ctx.mfaVerified) throw new AppError('FORBIDDEN', 'Admin MFA required', { mfaRequired: true });
  if (!isAdminRole(ctx.role)) throw new AppError('FORBIDDEN', 'Admin access required');
  if (ADMIN_ROLE_RANK[ctx.role] < ADMIN_ROLE_RANK[minRole]) {
    throw new AppError('FORBIDDEN', 'Insufficient admin role', { required: minRole });
  }
  return ctx.role;
}

/** POST /api/admin/mfa/verify {totp} → 204. */
export async function verifyAdminMfa(ctx: ActorContext, body: unknown): Promise<void> {
  const { totp } = parseMfaVerify(body);
  const { memberId } = requireMember(ctx);
  const meta = requestMetaOf(ctx);
  if (!meta?.sessionId || !meta.session) throw new AppError('UNAUTHENTICATED', 'Session required');
  const member = await getMember(memberId);
  if (!member || !member.is_admin || member.admin_role === null) throw new AppError('FORBIDDEN', 'Admin access required');
  if (!member.totp_secret_enc) throw new AppError('FORBIDDEN', 'MFA is not set up for this admin', { mfaNotEnrolled: true });

  const cfg = identityConfig();
  const nowMs = Date.now();
  const limit = await rateStore().hit(
    [{ key: `m05:mfa:attempt:${memberId}`, limit: cfg.mfa.attemptsPer15Min, windowSec: 15 * 60 }],
    nowMs,
    true,
  );
  if (!limit.allowed) throw rateLimited(limit.retryAfterSec, 'Too many MFA attempts');

  const secret = decrypt(member.totp_secret_enc, totpAad(memberId));
  const step = verifyTotp(secret, totp, nowMs, cfg.mfa.stepSec, cfg.mfa.window);
  if (step === null) throw new AppError('VALIDATION', 'Incorrect code', { field: 'totp' });

  // Replay protection: each time step can be used once per admin.
  const fresh = await getRedis().set(`m05:mfa:used:${memberId}:${step}`, '1', 'EX', cfg.mfa.stepSec * (2 * cfg.mfa.window + 2), 'NX');
  if (fresh === null) throw new AppError('VALIDATION', 'This code was already used; wait for the next one', { field: 'totp' });

  const s = meta.session;
  const cap = s.created_at.getTime() + cfg.session.adminTtlSec * 1000;
  const expiresAt = new Date(Math.min(s.expires_at.getTime(), cap));
  await setSessionMfaVerified(s.id, expiresAt);
  log.info({ memberId, adminRole: member.admin_role }, 'admin mfa verified');
}

/**
 * Operations tool: generates and stores a new TOTP secret for an admin member and returns
 * the otpauth:// URI to show once as a QR code. Replaces any previous secret.
 */
export async function provisionAdminTotp(memberId: string, label: string, issuer = 'ExportBuyers Admin'): Promise<{ otpauthUri: string }> {
  const secret = newTotpSecret();
  await setTotpSecret(memberId, encrypt(secret, totpAad(memberId)));
  const b32 = base32Encode(secret);
  const uri =
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
    `?secret=${b32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${identityConfig().mfa.stepSec}`;
  return { otpauthUri: uri };
}
