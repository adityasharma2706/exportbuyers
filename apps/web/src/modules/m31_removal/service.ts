/**
 * M31 — core service (IF-31a).
 *
 *   POST /api/public/removal {requesterEmail, kind, identifiers, details?, turnstileToken}
 *     -> 202 {sent: true, expiresInHours}; a verification email with a 24h token is sent.
 *   GET  /api/public/removal/verify?token=
 *     -> {filed: true, itemId, alreadyProcessed}; files the M11 `removal.request` review item
 *        (dedupe key = sha256 of the normalised identifiers, per LLD M31 API).
 *
 * No login is required for either step (LLD M31: "A no-login public form"). Anonymous abuse is
 * bounded by M05's `guardAnonymous(ctx, 'public_form')` (rate limit + Turnstile past its
 * threshold) and by the requester needing to control the destination email address to ever reach
 * `verify`. [deviation: LLD IF-31a's `turnstileToken` field implies Turnstile is checked on every
 * submission; M05's public IF-05c `guardAnonymous` only requires it once a visitor is past a
 * usage threshold for the bucket (its own, unmodified rule — M05 exposes no lower-level "verify
 * this token unconditionally" primitive). The token is still forwarded and checked whenever
 * `guardAnonymous` does require it; nothing here treats `turnstileToken` as decorative.]
 */
import { z } from 'zod';
import { AppError, log, newId, systemDb, withSpan, type ActorContext } from '../m01_platform/index.js';
import { guardAnonymous, type HttpRequestLike, sendTransactionalEmail } from '../m05_identity/index.js';
import { matchByIdentifiers, normalise } from '../m10_policy/index.js';
import { file } from '../m11_review/index.js';
import type { Tx } from '../m02_queue/index.js';
import { removalConfig } from './config.js';
import { generateToken, sha256Hex } from './crypto.js';
import { consumeChallenge, findChallengeByTokenHash, insertChallenge } from './repo.js';
import { REMOVAL_REQUEST_TYPE } from './reviewTypes.js';
import {
  REMOVAL_KINDS,
  type IdentityCheck,
  type NormalisedIdentifiers,
  type RemovalIdentifiersInput,
  type RemovalKind,
  type RemovalRequestPayload,
  type RequestRemovalResponseDto,
  type VerifyRemovalResponseDto,
} from './types.js';

export const VERIFY_EMAIL_TEMPLATE = 'removal.verify';
const CHALLENGE_TOKEN_RE = /^[A-Za-z0-9_-]{20,512}$/;

// ---------------------------------------------------------------------------------------------
// POST /api/public/removal
// ---------------------------------------------------------------------------------------------

const identifiersInputSchema = z
  .object({
    domain: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().min(3).max(320).optional(),
    phone: z.string().trim().min(3).max(32).optional(),
    companyName: z.string().trim().min(1).max(300).optional(),
    country: z.string().trim().min(2).max(100).optional(),
  })
  .strict();

const requestRemovalSchema = z.object({
  requesterEmail: z.string().trim().toLowerCase().email().max(320),
  kind: z.enum(REMOVAL_KINDS as [RemovalKind, ...RemovalKind[]]),
  identifiers: identifiersInputSchema,
  details: z.string().trim().max(2000).optional(),
  turnstileToken: z.string().min(1).max(4096),
});

function normaliseIdentifiers(raw: RemovalIdentifiersInput): NormalisedIdentifiers {
  const out: NormalisedIdentifiers = {};
  if (raw.domain) out.domain = normalise('domain', raw.domain);
  if (raw.email) out.email = normalise('email', raw.email);
  if (raw.phone) out.phone = normalise('phone', raw.phone);
  if (raw.companyName) out.companyName = raw.companyName.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (raw.country) out.country = raw.country.trim().toUpperCase().slice(0, 100);
  return out;
}

function requesterDomain(requesterEmail: string): string | null {
  try {
    const n = normalise('email', requesterEmail);
    const at = n.lastIndexOf('@');
    return at > 0 ? n.slice(at + 1) : null;
  } catch {
    return null;
  }
}

function targetDomain(ids: NormalisedIdentifiers): string | null {
  if (ids.domain) return ids.domain;
  if (ids.email) {
    const at = ids.email.lastIndexOf('@');
    return at > 0 ? ids.email.slice(at + 1) : null;
  }
  return null;
}

/** LLD M31 Rules: "The requester's email must be on the same domain as the identifier being
 * removed. Otherwise the item is flagged needs_identity_check for the operator; it is still
 * filed." A submission with no domain-comparable identifier (companyName/country/phone only)
 * cannot be checked either way, so it is flagged too. */
function computeIdentityCheck(requesterEmail: string, ids: NormalisedIdentifiers): IdentityCheck {
  const target = targetDomain(ids);
  const requester = requesterDomain(requesterEmail);
  return target !== null && requester !== null && target === requester ? 'ok' : 'needs_identity_check';
}

function buildVerifyUrl(token: string): string {
  return `${removalConfig().publicBaseUrl}/en/removal/verify?token=${encodeURIComponent(token)}`;
}

/** Injects the Turnstile token as the header M05's guardAnonymous reads, without mutating the
 * original request object (needed because IF-31a carries the token in the JSON body, while
 * `guardAnonymous` reads `cf-turnstile-response` / `x-turnstile-token`). */
function withTurnstileHeader(req: HttpRequestLike, token: string): HttpRequestLike {
  return { ...req, headers: { ...req.headers, 'x-turnstile-token': token } };
}

/** IF-31a `POST /api/public/removal`. */
export async function requestRemoval(ctx: ActorContext, req: HttpRequestLike, rawBody: unknown): Promise<RequestRemovalResponseDto> {
  const parsed = requestRemovalSchema.safeParse(rawBody ?? {});
  if (!parsed.success) throw new AppError('VALIDATION', 'Invalid removal request', { issues: parsed.error.message });
  const body = parsed.data;

  const hasIdentifier = Object.values(body.identifiers).some((v) => v !== undefined);
  if (!hasIdentifier) throw new AppError('VALIDATION', 'At least one identifier is required', { field: 'identifiers' });
  if (body.kind === 'correction' && (!body.details || body.details.length === 0)) {
    throw new AppError('VALIDATION', 'Describe what needs correcting in details', { field: 'details' });
  }

  await guardAnonymous(ctx, 'public_form', withTurnstileHeader(req, body.turnstileToken));

  return withSpan(
    'm31.requestRemoval',
    async () => {
      let identifiers: NormalisedIdentifiers;
      try {
        identifiers = normaliseIdentifiers(body.identifiers);
      } catch (err) {
        throw new AppError('VALIDATION', 'One or more identifiers could not be understood', { field: 'identifiers' }, { cause: err });
      }

      let matchedCompanyId: string | null = null;
      try {
        const matched = await matchByIdentifiers(ctx, { domain: identifiers.domain, email: identifiers.email });
        matchedCompanyId = matched ?? null;
      } catch (err) {
        log.warn({ err }, 'm31: catalogue match failed; filing without a matched company');
      }

      const identityCheck = computeIdentityCheck(body.requesterEmail, identifiers);
      const cfg = removalConfig();
      const id = newId<'removal_challenge'>();
      const token = generateToken();
      const expiresAt = new Date(Date.now() + cfg.challengeTtlHours * 3_600_000);

      await insertChallenge(systemDb('m31: file removal challenge'), {
        id,
        kind: body.kind,
        requesterEmail: body.requesterEmail,
        identifiers,
        matchedCompanyId,
        identityCheck,
        details: body.details ?? null,
        tokenHash: sha256Hex(token),
        expiresAt,
      });

      await sendTransactionalEmail(
        body.requesterEmail,
        VERIFY_EMAIL_TEMPLATE,
        { verifyUrl: buildVerifyUrl(token), kind: body.kind, ttlHours: cfg.challengeTtlHours },
        { idempotencyKey: `m31:verify-email:${id}` },
      );

      log.info({ challengeId: id, kind: body.kind, identityCheck }, 'm31 removal challenge issued');
      return { sent: true as const, expiresInHours: cfg.challengeTtlHours };
    },
    { kind: body.kind },
  );
}

// ---------------------------------------------------------------------------------------------
// GET /api/public/removal/verify
// ---------------------------------------------------------------------------------------------

function canonicalIdentifiers(ids: NormalisedIdentifiers): Record<string, string | null> {
  return {
    domain: ids.domain ?? null,
    email: ids.email ?? null,
    phone: ids.phone ?? null,
    companyName: ids.companyName ?? null,
    country: ids.country ?? null,
  };
}

/** LLD M31 API: "dedupe key = sha of the normalised identifiers." */
function computeDedupeKey(ids: NormalisedIdentifiers): string {
  return sha256Hex(JSON.stringify(canonicalIdentifiers(ids)));
}

function expiredError(): AppError {
  return new AppError('VALIDATION', 'This link is invalid or has expired; please submit the form again', { expired: true });
}

/** IF-31a `GET /api/public/removal/verify?token=`. */
export async function verifyRemoval(ctx: ActorContext, rawToken: unknown): Promise<VerifyRemovalResponseDto> {
  void ctx; // resolved for consistency with every other public route; not otherwise needed here.
  if (typeof rawToken !== 'string' || !CHALLENGE_TOKEN_RE.test(rawToken)) {
    throw new AppError('VALIDATION', 'A verification token is required', { field: 'token' });
  }
  const tokenHash = sha256Hex(rawToken);

  return withSpan('m31.verifyRemoval', async () => {
    const row = await findChallengeByTokenHash(systemDb('m31: verify lookup'), tokenHash);
    if (!row) throw expiredError();

    if (row.consumedAt !== null) {
      if (row.reviewItemId) return { filed: true as const, itemId: row.reviewItemId, alreadyProcessed: true };
      // Consumed by a concurrent call that has not yet recorded its review item id; treat as
      // expired rather than racing further — the caller can reload the link.
      throw expiredError();
    }
    if (row.expiresAt.getTime() < Date.now()) throw expiredError();

    const dedupeKey = computeDedupeKey(row.identifiers);
    const payload: RemovalRequestPayload = {
      kind: row.kind,
      requesterEmail: row.requesterEmail,
      identifiers: row.identifiers,
      matchedCompanyId: row.matchedCompanyId,
      details: row.details,
      identityCheck: row.identityCheck,
    };
    const subjectRefs = row.matchedCompanyId
      ? [{ kind: 'company', id: row.matchedCompanyId }]
      : [{ kind: 'removal_identifiers', id: dedupeKey }];

    const itemId = await systemDb('m31: file removal request')
      .transaction()
      .execute(async (tx: Tx) => {
        const filedId = await file(tx, REMOVAL_REQUEST_TYPE, {
          subjectRefs,
          payload,
          filedBy: { kind: 'public', ref: sha256Hex(row.requesterEmail) },
          dedupeKey,
        });
        const consumed = await consumeChallenge(tx, row.id, filedId);
        if (!consumed) throw new AppError('CONFLICT', 'This link was already used a moment ago');
        return filedId;
      });

    log.info({ challengeId: row.id, itemId, identityCheck: row.identityCheck }, 'm31 removal request filed');
    return { filed: true as const, itemId, alreadyProcessed: false };
  });
}
