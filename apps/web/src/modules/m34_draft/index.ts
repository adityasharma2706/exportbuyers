/**
 * M34 Outreach drafting: first contact — public API. Other modules import ONLY from this file.
 *
 * REQ-038/039/040 (LLM-drafted, editable, streamed first-contact message with a
 * compliance footer assembled in code) and REQ-029's draft block (refused on a sanctions block
 * or suppression — LLD sequence steps 1-2).
 *
 * API  POST /api/drafts {entryId, language, tone} -> SSE (data:{delta} … event:footer
 *      data:{footer} event:done data:{draftId})
 *      PATCH /api/drafts/:id {bodyEdited} ; POST /api/drafts/:id/handoff {via} -> 204, emits EV-09
 * IF-34b buildFooter(profile, buyer, language) — pure function, assembled in code from the
 *      literal LLD wording (M37's content templates do not exist yet; see footer.ts).
 * IF-34c the handoff endpoint above.
 */
export { DRAFT_HANDOFF_VIA, DRAFT_KINDS, DRAFT_TONES, FIRST_CONTACT_KIND } from './types.js';
export type {
  CreateDraftRequestDto,
  Draft,
  DraftDeltaEvent,
  DraftDoneEvent,
  DraftDto,
  DraftFooterEvent,
  DraftHandoffVia,
  DraftKind,
  DraftRow,
  DraftStreamEvent,
  DraftTone,
  HandoffRequestDto,
  PatchDraftRequestDto,
} from './types.js';

export { draftConfig, loadDraftConfigFromEnv, resetDraftConfigForTesting, setDraftConfig } from './config.js';
export type { DraftConfig } from './config.js';

export {
  objectBody,
  parseCreateDraftRequest,
  parseDraftIdParam,
  parseHandoffRequest,
  parsePatchDraftRequest,
} from './validate.js';

export { EU_EEA_UK_CH_COUNTRIES, buildFooter } from './footer.js';
export type { FooterBuyer, FooterBusinessProfile } from './footer.js';

export { buildDraftPrompt, pickEvidenceSnippets, sanitizeSnippet } from './prompt.js';
export type { DraftPromptInput, EvidenceSnippet } from './prompt.js';

export { handoffDraft, patchDraft, streamDraftGeneration, toDraftDto } from './service.js';

export { registerDraftRoutes } from './routes.js';
export type { DraftRawResponseLike, DraftRouteApp, DraftRouteReply, DraftRouteRequest } from './routes.js';

export { DRAFT_MESSAGES_EN, DRAFT_NAMESPACE, resolveDraftLabels } from './labels.js';
export type { DraftLabelKey, DraftLabels } from './labels.js';

export { DraftComposer } from './components/DraftComposer.js';
export type { DraftComposerProps } from './components/DraftComposer.js';
