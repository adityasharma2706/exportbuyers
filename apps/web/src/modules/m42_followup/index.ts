/**
 * M42 Follow-up drafts — public API. Other modules import ONLY from this file.
 *
 * REQ-041: second and third touch drafts that reuse the parent draft's stored thread context
 * (`body_edited ?? body_generated`), with the same M10/M17 policy-and-sanctions gate and the same
 * IF-34b compliance footer as M34, at most 2 follow-ups per thread, blocked once the buyer has
 * replied (or moved further along the pipeline), and a suggested-timing reminder for the next
 * touch once the current one leaves the product.
 *
 * API      POST /api/drafts/:parentId/follow-up -> SSE (data:{delta} … event:footer
 *          data:{footer} event:done data:{draftId}), kind = follow_up_1|2, thread_parent =
 *          parentId. PATCH /api/drafts/:id and POST /api/drafts/:id/handoff are M34's own
 *          endpoints, reused as-is for follow-up drafts (see routes.ts's own header).
 * Event    subscribes to M33's EV-09 draft.left_product to schedule the next touch's reminder
 *          directly on M41's serving.reminder table (see events.ts's own header for why).
 */
export { FOLLOW_UP_KINDS } from './types.js';
export type { CreateFollowUpRequestDto, FollowUpDraftKind } from './types.js';

export {
  followUpConfig,
  loadFollowUpConfigFromEnv,
  nextFollowUpAfterHandoff,
  nextFollowUpKind,
  resetFollowUpConfigForTesting,
  setFollowUpConfig,
} from './config.js';
export type { FollowUpConfig } from './config.js';

export { parseCreateFollowUpRequest, parseParentIdParam } from './validate.js';

export { buildFollowUpPrompt } from './prompt.js';
export type { FollowUpPromptInput } from './prompt.js';

export { followUpDraftDto, streamFollowUpDraftGeneration } from './service.js';

export { registerFollowUpRoutes } from './routes.js';
export type { FollowUpRawResponseLike, FollowUpRouteApp, FollowUpRouteReply, FollowUpRouteRequest } from './routes.js';

export { registerFollowUpModule, resetFollowUpModuleForTesting } from './events.js';

export { FOLLOW_UP_MESSAGES_EN, FOLLOW_UP_NAMESPACE, resolveFollowUpLabels } from './labels.js';
export type { FollowUpLabelKey, FollowUpLabels } from './labels.js';

export { FollowUpComposer } from './components/FollowUpComposer.js';
export type { FollowUpComposerProps } from './components/FollowUpComposer.js';
