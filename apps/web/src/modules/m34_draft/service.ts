/**
 * M34 — draft generation and handoff (LLD M34 "Sequence" / "Rules" / IF-34c). REQ-038, REQ-039,
 * REQ-040, REQ-029 (draft block).
 *
 *   streamDraftGeneration(ctx, rawBody)   POST /api/drafts (consumed by routes.ts as SSE)
 *   patchDraft(ctx, id, rawBody)          PATCH /api/drafts/:id {bodyEdited}
 *   handoffDraft(ctx, id, rawBody)        POST /api/drafts/:id/handoff {via} -> emits EV-09
 *
 * LLD sequence:
 *  1. assertAllowed(ctx,'draft',companyId,'draft') (M10 — suppression/licence/region/plan).
 *  2. M17.screen must return clear; anything else -> error, nothing is generated.
 *  3. Build the prompt: business profile (name, product, city), HS description, <=5 company-level
 *     evidence snippets, buyer name + country. Never a contact value or a person's name.
 *  4. stream(tier:'draft', piiFree:false).
 *  5. When the stream ends, append the footer.
 * Rules: incomplete business profile -> VALIDATION {missing}; the draft is stored after the
 * stream finishes even if the client disconnects; 50 drafts/account/day [tunable].
 */
import { AppError, log, newId, rateLimited, scoped, systemDb, withSpan, type ActorContext } from '../m01_platform/index.js';
import { requireMember } from '../m05_identity/index.js';
import { emit, type Tx } from '../m02_queue/index.js';
import { stream } from '../m03_llm/index.js';
import { getBusinessProfile, getWorkspace, type BusinessProfile } from '../m07_tenancy/index.js';
import { assertAllowed, type ProfileDoc } from '../m10_policy/index.js';
import { assertSanctionsClear } from '../m17_sanctions/index.js';
import { EV_DRAFT_LEFT_PRODUCT, type DraftLeftProductPayload } from '../m33_pipeline/index.js';
import { draftConfig } from './config.js';
import { buildFooter, type FooterBuyer } from './footer.js';
import { buildDraftPrompt, pickEvidenceSnippets } from './prompt.js';
import {
  countDraftsSince,
  findDraftById,
  findShortlistEntryById,
  insertDraft,
  markDraftLeft,
  updateDraftBodyEdited,
  type ShortlistEntryLite,
} from './repo.js';
import { FIRST_CONTACT_KIND, type Draft, type DraftDto, type DraftStreamEvent } from './types.js';
import { parseCreateDraftRequest, parseDraftIdParam, parseHandoffRequest, parsePatchDraftRequest } from './validate.js';

function draftNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Draft not found');
}

export function toDraftDto(d: Draft): DraftDto {
  return {
    id: d.id,
    entryId: d.entryId,
    kind: d.kind,
    language: d.language,
    tone: d.tone,
    bodyGenerated: d.bodyGenerated,
    footer: d.footer,
    bodyEdited: d.bodyEdited,
    model: d.model,
    leftVia: d.leftVia,
    leftAt: d.leftAt ? d.leftAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
  };
}

function businessProfileMissingFields(p: BusinessProfile): string[] {
  const missing: string[] = [];
  if (!p.businessName || p.businessName.trim().length === 0) missing.push('businessName');
  if (!p.senderName || p.senderName.trim().length === 0) missing.push('senderName');
  return missing;
}

interface PreparedDraft {
  entry: ShortlistEntryLite;
  doc: ProfileDoc;
  businessProfile: BusinessProfile;
  system: string;
  user: string;
  evidenceSourceTypes: string[];
}

/** Every LLD sequence step before the LLM call (1-3), plus the rate limit and profile-completeness
 * rules. Throws before anything is generated, per LLD Rules. */
async function prepareDraft(ctx: ActorContext, accountId: string, entryId: string, language: string, tone: 'formal' | 'friendly'): Promise<PreparedDraft> {
  return withSpan(
    'm34.prepareDraft',
    async () => {
      const cfg = draftConfig();
      const since = new Date(Date.now() - 24 * 3_600_000);
      const usedToday = await countDraftsSince(ctx, since);
      if (usedToday >= cfg.draftsPerAccountPerDay) {
        throw rateLimited(3_600, 'Too many drafts today; please try again tomorrow', { limit: cfg.draftsPerAccountPerDay });
      }

      const entry = await findShortlistEntryById(scoped(ctx), entryId);
      if (!entry || entry.accountId !== accountId) throw new AppError('NOT_FOUND', 'Shortlist entry not found');

      const businessProfile = await getBusinessProfile(ctx);
      const missing = businessProfileMissingFields(businessProfile);
      if (missing.length > 0) {
        throw new AppError('VALIDATION', 'Business profile is incomplete for drafting', { missing });
      }

      // LLD sequence step 1: M10's suppression/licence/region/plan gate.
      const doc = await assertAllowed(ctx, 'draft', entry.companyId, 'draft');
      // LLD sequence step 2: "M17.screen must return clear. Anything else -> error, and nothing
      // is generated." A fresh, authoritative check on top of M10's own cached sanctions flag.
      await assertSanctionsClear(ctx, entry.companyId);

      let hsCode: string | null = null;
      try {
        const workspace = await getWorkspace(ctx, entry.workspaceId);
        hsCode = workspace.hs?.code ?? null;
      } catch (err) {
        log.warn({ err, workspaceId: entry.workspaceId }, 'm34: could not resolve workspace HS code; drafting without it');
      }

      const evidence = pickEvidenceSnippets(doc, cfg.maxEvidenceSnippets);
      const evidenceSourceTypes = [...new Set(evidence.map((e) => e.sourceType))];

      const { system, user } = buildDraftPrompt({
        tone,
        language,
        businessName: businessProfile.businessName,
        whatTheyMake: businessProfile.whatTheyMake,
        city: businessProfile.city,
        hsCode,
        buyerName: doc.name,
        buyerCountry: doc.country,
        evidence,
      });

      return { entry, doc, businessProfile, system, user, evidenceSourceTypes };
    },
    { entryId },
  );
}

/**
 * IF-03a `stream(tier:'draft', piiFree:false)` (LLD sequence step 4), streamed out as
 * `{type:'delta'}` events, then the appended footer (step 5) as a `{type:'footer'}` event, then
 * `{type:'done'}` once the draft row is stored. The draft is stored here regardless of whether
 * the caller keeps iterating (LLD Rules: "If the client disconnects, the draft is stored
 * anyway.") — this function itself does not know or care whether anything is still reading it.
 */
export async function* streamDraftGeneration(ctx: ActorContext, rawBody: unknown): AsyncGenerator<DraftStreamEvent, void, void> {
  const { accountId } = requireMember(ctx);
  const input = parseCreateDraftRequest(rawBody);

  const prep = await prepareDraft(ctx, accountId, input.entryId, input.language, input.tone);

  const llmStream = stream({
    tier: 'draft',
    // Draft prompts carry the user's business details (LLD M03 Rules), so piiFree is false: only
    // the purpose, token counts and a hash are logged, never the prompt or output text.
    piiFree: false,
    purpose: 'm34.draft_first_contact',
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
  await insertDraft(
    scoped(ctx),
    {
      id: draftId,
      workspaceId: prep.entry.workspaceId,
      entryId: prep.entry.id,
      kind: FIRST_CONTACT_KIND,
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

/** PATCH /api/drafts/:id {bodyEdited} (LLD M34 API). */
export async function patchDraft(ctx: ActorContext, rawId: unknown, rawBody: unknown): Promise<DraftDto> {
  requireMember(ctx);
  const id = parseDraftIdParam(rawId);
  const { bodyEdited } = parsePatchDraftRequest(rawBody);
  const updated = await updateDraftBodyEdited(scoped(ctx), id, bodyEdited);
  if (!updated) throw draftNotFound();
  return toDraftDto(updated);
}

/** Emits EV-09 in its own transaction, the same pattern M33's own EV-08 emitter uses (ScopedDb
 * does not expose the raw Tx that emit() needs). A failure to emit never fails the handoff call
 * itself: the user has already copied/opened the draft by the time this runs. */
async function emitDraftLeftProduct(payload: Omit<DraftLeftProductPayload, 'v'>): Promise<void> {
  try {
    await systemDb('m34: draft left product').transaction().execute((tx: Tx) => emit(tx, EV_DRAFT_LEFT_PRODUCT, { v: 1, ...payload }));
  } catch (err) {
    log.error({ err, payload }, 'm34: failed to emit draft.left_product');
  }
}

/**
 * POST /api/drafts/:id/handoff {via} (LLD M34 IF-34c): "Leaves the product only by copy or
 * mailto:" (plus WhatsApp's wa.me, per M33's own EV-09 payload union). Idempotent: a draft
 * already marked left is a no-op (204), the same way M33 treats "setting the same status" as a
 * no-op, so a repeated handoff call never re-emits EV-09 or re-runs the auto-`contacted` step.
 */
export async function handoffDraft(ctx: ActorContext, rawId: unknown, rawBody: unknown): Promise<void> {
  const { accountId } = requireMember(ctx);
  const id = parseDraftIdParam(rawId);
  const { via } = parseHandoffRequest(rawBody);
  const now = new Date();
  const sdb = scoped(ctx);

  const existing = await findDraftById(sdb, id);
  if (!existing) throw draftNotFound();
  if (existing.leftAt) return; // already recorded

  const updated = await markDraftLeft(sdb, id, via, now);
  if (!updated) throw draftNotFound();

  const entry = await findShortlistEntryById(sdb, updated.entryId);
  if (!entry) {
    log.warn({ draftId: id, entryId: updated.entryId }, 'm34: handoff on a draft whose shortlist entry is gone; skipping EV-09');
    return;
  }

  await emitDraftLeftProduct({
    entryId: updated.entryId,
    accountId,
    workspaceId: updated.workspaceId,
    companyId: entry.companyId,
    via,
    at: now.toISOString(),
  });
}
