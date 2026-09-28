/**
 * M42 — follow-up (second/third touch) draft generation. REQ-041.
 *
 *   streamFollowUpDraftGeneration(ctx, parentId, rawBody)   POST /api/drafts/:parentId/follow-up
 *
 * LLD M42 Rules:
 *  - "an SSE stream, the same as M34, with kind = follow_up_1|2" — the wire format
 *    (data:{delta} … event:footer data:{footer} event:done data:{draftId}) is identical to M34's.
 *  - "Thread context = the parent draft's body_edited ?? body_generated."
 *  - "At most 2 follow-ups per thread" (config.ts's `nextFollowUpKind`).
 *  - "The same policy, sanctions and footer steps as M34 apply" — M34's own `assertAllowed`
 *    surface/action pair, `assertSanctionsClear`, and `buildFooter` are reused verbatim here, not
 *    re-implemented.
 *  - "Status replied, or anything further along -> CONFLICT 'buyer already replied'."
 *
 * PATCH /api/drafts/:id and POST /api/drafts/:id/handoff are M34's own endpoints, reused as-is for
 * follow-up drafts too (see M34's routes.ts: neither route branches on `kind`). This module adds
 * no patch/handoff route of its own. The "createReminder for the next one" half of REQ-041 lives
 * in events.ts, triggered by the same handoff.
 */
import { AppError, log, newId, scoped, withSpan, type ActorContext } from '../m01_platform/index.js';
import { requireMember } from '../m05_identity/index.js';
import { stream } from '../m03_llm/index.js';
import { getBusinessProfile, getWorkspace, type BusinessProfile } from '../m07_tenancy/index.js';
import { assertAllowed, type ProfileDoc } from '../m10_policy/index.js';
import { assertSanctionsClear } from '../m17_sanctions/index.js';
import { SHORTLIST_STATUSES, type ShortlistStatus } from '../m33_pipeline/index.js';
import {
  buildFooter,
  pickEvidenceSnippets,
  toDraftDto,
  type Draft,
  type DraftDto,
  type DraftStreamEvent,
  type FooterBuyer,
} from '../m34_draft/index.js';
import { followUpConfig, nextFollowUpKind } from './config.js';
import { buildFollowUpPrompt } from './prompt.js';
import { findDraftById, findShortlistEntryForFollowUp, insertFollowUpDraft, type ShortlistEntryForFollowUp } from './repo.js';
import type { CreateFollowUpRequestDto, FollowUpDraftKind } from './types.js';
import { parseCreateFollowUpRequest, parseParentIdParam } from './validate.js';

function draftNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Draft not found');
}

/**
 * LLD M42 Rules: "Status replied, or anything further along -> CONFLICT". M33's own
 * `SHORTLIST_STATUSES` is ordered `to_contact, contacted, replied, in_discussion, sample_sent,
 * order_won, not_interested`; 'replied' and everything listed after it (which also covers
 * 'not_interested', at the end of that list) blocks a new follow-up.
 */
const REPLIED_INDEX = SHORTLIST_STATUSES.indexOf('replied');

function blocksFollowUp(status: ShortlistStatus): boolean {
  return SHORTLIST_STATUSES.indexOf(status) >= REPLIED_INDEX;
}

/** Same rule M34's own service.ts applies before drafting. */
function businessProfileMissingFields(p: BusinessProfile): string[] {
  const missing: string[] = [];
  if (!p.businessName || p.businessName.trim().length === 0) missing.push('businessName');
  if (!p.senderName || p.senderName.trim().length === 0) missing.push('senderName');
  return missing;
}

interface PreparedFollowUp {
  parent: Draft;
  entry: ShortlistEntryForFollowUp;
  doc: ProfileDoc;
  businessProfile: BusinessProfile;
  nextKind: FollowUpDraftKind;
  system: string;
  user: string;
  evidenceSourceTypes: string[];
}

/** Everything before the first `yield`: validation, the max-2 rule, the reply-status gate, the
 * M10/M17 policy and sanctions gate, and the business-profile completeness check. Throws before
 * anything is generated (LLD M34's own "nothing is generated" rule, reused here). */
async function prepareFollowUp(
  ctx: ActorContext,
  parentId: string,
  language: string,
  tone: CreateFollowUpRequestDto['tone'],
): Promise<PreparedFollowUp> {
  return withSpan(
    'm42.prepareFollowUp',
    async () => {
      const sdb = scoped(ctx);
      const cfg = followUpConfig();

      const parent = await findDraftById(sdb, parentId);
      if (!parent) throw draftNotFound();

      // LLD Rules: "At most 2 follow-ups per thread." Throws VALIDATION once the parent is
      // already the second follow-up, or is not a followable kind at all.
      const nextKind = nextFollowUpKind(parent.kind);

      const entry = await findShortlistEntryForFollowUp(sdb, parent.entryId);
      if (!entry) throw new AppError('NOT_FOUND', 'Shortlist entry not found');

      // LLD Rules: "Status replied, or anything further along -> CONFLICT 'buyer already replied'."
      if (blocksFollowUp(entry.status)) {
        throw new AppError('CONFLICT', 'buyer already replied', { status: entry.status });
      }

      const businessProfile = await getBusinessProfile(ctx);
      const missing = businessProfileMissingFields(businessProfile);
      if (missing.length > 0) {
        throw new AppError('VALIDATION', 'Business profile is incomplete for drafting', { missing });
      }

      // LLD Rules: "the same policy, sanctions ... steps as M34 apply" (M34 sequence steps 1-2).
      const doc = await assertAllowed(ctx, 'draft', entry.companyId, 'draft');
      await assertSanctionsClear(ctx, entry.companyId);

      let hsCode: string | null = null;
      try {
        const workspace = await getWorkspace(ctx, parent.workspaceId);
        hsCode = workspace.hs?.code ?? null;
      } catch (err) {
        log.warn({ err, workspaceId: parent.workspaceId }, 'm42: could not resolve workspace HS code; drafting without it');
      }

      const evidence = pickEvidenceSnippets(doc, cfg.maxEvidenceSnippets);
      const evidenceSourceTypes = [...new Set(evidence.map((e) => e.sourceType))];

      // LLD Rules: "Thread context = the parent draft's body_edited ?? body_generated."
      const threadContext = parent.bodyEdited ?? parent.bodyGenerated;

      const { system, user } = buildFollowUpPrompt({
        touch: nextKind === 'follow_up_1' ? 2 : 3,
        tone,
        language,
        businessName: businessProfile.businessName,
        whatTheyMake: businessProfile.whatTheyMake,
        city: businessProfile.city,
        hsCode,
        buyerName: doc.name,
        buyerCountry: doc.country,
        threadContext,
        evidence,
      });

      return { parent, entry, doc, businessProfile, nextKind, system, user, evidenceSourceTypes };
    },
    { parentId },
  );
}

/**
 * POST /api/drafts/:parentId/follow-up (LLD M42): the same SSE shape as M34's own
 * `streamDraftGeneration`. The draft is stored once the stream ends, the same way M34 stores its
 * own drafts — even if the client disconnects mid-stream, the generator is still drained to
 * completion by the route layer and the draft is stored.
 */
export async function* streamFollowUpDraftGeneration(
  ctx: ActorContext,
  rawParentId: unknown,
  rawBody: unknown,
): AsyncGenerator<DraftStreamEvent, void, void> {
  requireMember(ctx);
  const parentId = parseParentIdParam(rawParentId);
  const input = parseCreateFollowUpRequest(rawBody);

  const prep = await prepareFollowUp(ctx, parentId, input.language, input.tone);

  const llmStream = stream({
    tier: 'draft',
    // Follow-up prompts carry business details and the prior thread text (LLD M03 Rules), so
    // piiFree is false, exactly as M34's own first-contact drafts.
    piiFree: false,
    purpose: prep.nextKind === 'follow_up_1' ? 'm42.draft_follow_up_1' : 'm42.draft_follow_up_2',
    system: prep.system,
    messages: [{ role: 'user', content: prep.user }],
    ctx,
  });

  let bodyGenerated = '';
  for await (const chunk of llmStream) {
    if (chunk.delta.length === 0) continue;
    bodyGenerated += chunk.delta;
    yield { type: 'delta', delta: chunk.delta };
  }
  const result = await llmStream.final;
  const finalText = result.text.length > 0 ? result.text : bodyGenerated;

  // LLD Rules: "the same ... footer steps as M34 apply" — M34's own IF-34b buildFooter, unchanged.
  const buyer: FooterBuyer = { country: prep.doc.country, evidenceSourceTypes: prep.evidenceSourceTypes };
  const footer = buildFooter(
    {
      businessName: prep.businessProfile.businessName,
      senderName: prep.businessProfile.senderName ?? prep.businessProfile.businessName,
      city: prep.businessProfile.city,
      state: prep.businessProfile.state,
      iec: prep.businessProfile.iec,
    },
    buyer,
    input.language,
  );

  const draftId = newId<'draft'>();
  const now = new Date();
  await insertFollowUpDraft(
    scoped(ctx),
    {
      id: draftId,
      workspaceId: prep.parent.workspaceId,
      entryId: prep.parent.entryId,
      kind: prep.nextKind,
      threadParent: prep.parent.id,
      language: input.language,
      tone: input.tone,
      bodyGenerated: finalText,
      footer,
      model: result.model,
    },
    now,
  );

  yield { type: 'footer', footer };
  yield { type: 'done', draftId };
}

/** Serialises a follow-up `Draft` the same way M34 serialises its own (reused directly: the two
 * modules share one row shape and one wire DTO). */
export function followUpDraftDto(d: Draft): DraftDto {
  return toDraftDto(d);
}
