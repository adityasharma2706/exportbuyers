/**
 * M27 — buyer profile server side (IF-27a). REQ-021, REQ-017, REQ-022, REQ-024, REQ-027,
 * REQ-028, REQ-029.
 *
 *   getBuyerProfile(ctx, companyId, workspaceId?)   GET /api/buyers/:companyId?workspaceId=
 *
 * Every read goes through M10 (IF-10a `byIds`), which already applies suppression, sanctions,
 * licence, region, logistics, per-user hides and plan entitlements (LLD M27: "Goes through M10").
 * `byIds` also follows `v_company_redirect` (LLD: "The company id is resolved through
 * v_company_redirect"): a redirect shows up as the returned doc's `company_id` differing from the
 * id that was requested, which this module surfaces as `redirectedFrom`.
 */
import { AppError, isUuid, log, withSpan, type ActorContext, type Id } from '../m01_platform/index.js';
import { byIds, type PolicyDecision, type ProfileDoc } from '../m10_policy/index.js';
import { toProfileDto } from './dto.js';
import { evaluateRedFlags, isRevealed, shortlistEntryFor } from './providers.js';
import type { BuyerProfileResponseDto } from './types.js';

function hiddenDecision(): PolicyDecision {
  return { visibility: 'hidden', allowed: [], redactedFields: [], reasons: [] };
}

/**
 * LLD M27 rule: "`hidden` → NOT_FOUND. There is one exception: when the user's own hide is the
 * only reason, return 404 with details.userHidden=true so the UI can offer an 'unhide' link."
 * M10's `evaluate()` (rules.ts) short-circuits to a single-reason decision for every hidden case
 * (suppression, logistics default-hide, per-user hide), so `reasons` is `['USER_HIDDEN']` exactly
 * when that is the sole cause.
 */
function throwNotFound(decision: PolicyDecision): never {
  const userHidden = decision.reasons.length === 1 && decision.reasons[0] === 'USER_HIDDEN';
  throw new AppError('NOT_FOUND', 'Company not found', userHidden ? { userHidden: true } : undefined);
}

function parseCompanyId(raw: unknown): string {
  if (typeof raw !== 'string' || !isUuid(raw)) {
    throw new AppError('VALIDATION', 'companyId must be a uuid', { field: 'companyId' });
  }
  return raw.toLowerCase();
}

function parseWorkspaceId(raw: unknown, ctx: ActorContext): string | null {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return ctx.workspaceId ?? null;
}

/** GET /api/buyers/:companyId?workspaceId= (IF-27a). */
export async function getBuyerProfile(
  ctx: ActorContext,
  rawCompanyId: unknown,
  rawWorkspaceId?: unknown,
): Promise<BuyerProfileResponseDto> {
  // LLD M27 rule: "Anonymous visitors → SIGNUP_REQUIRED." (byIds itself has no such restriction —
  // it is M10's `search` surface that does — so this module enforces it for `profile`.)
  if (ctx.kind === 'anonymous') {
    throw new AppError('SIGNUP_REQUIRED', 'Sign up to view buyer profiles');
  }
  const companyId = parseCompanyId(rawCompanyId);
  const workspaceId = parseWorkspaceId(rawWorkspaceId, ctx);

  return withSpan(
    'm27.getBuyerProfile',
    async () => {
      const res = await byIds(ctx, 'profile', [companyId]);
      const entry = res.get(companyId as Id<'company'>);
      const decision = entry?.decision ?? hiddenDecision();

      if (!entry || !entry.doc || decision.visibility === 'hidden') throwNotFound(decision);
      const doc: ProfileDoc = entry.doc;

      const [redFlags, revealed, shortlistEntry] = await Promise.all([
        evaluateRedFlags(ctx, doc),
        isRevealed(ctx, doc.company_id),
        shortlistEntryFor(ctx, workspaceId, doc.company_id),
      ]);

      const out: BuyerProfileResponseDto = {
        profile: toProfileDto(doc, decision),
        decision,
        redFlags,
        revealed,
      };
      if (shortlistEntry) out.shortlistEntry = shortlistEntry;
      // LLD M27 rule: "If it redirects, the response has redirectedFrom."
      if (doc.company_id.toLowerCase() !== companyId) out.redirectedFrom = companyId;
      return out;
    },
    { companyId },
  ).catch((err: unknown) => {
    if (!(err instanceof AppError)) log.error({ err, companyId }, 'm27: getBuyerProfile failed');
    throw err;
  });
}
