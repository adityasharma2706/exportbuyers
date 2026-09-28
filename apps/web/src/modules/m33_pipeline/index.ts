/**
 * M33 Pipeline: shortlists, statuses and notes — public API. Other modules import ONLY from
 * this file.
 *
 * IF-33a Pipeline: shortlist add (single/bulk), status change (emits EV-08), notes, the
 *        "My buyers" cross-workspace view.
 * Events EV-08 pipeline.status_changed (emitted here) ; EV-09 draft.left_product (subscribed
 *        here, from M34 once it exists — auto-sets status to Contacted).
 * Routes POST /api/workspaces/:ws/shortlist ; GET /api/workspaces/:ws/shortlist?status
 *        PATCH /api/shortlist/:id
 *        POST|PATCH|DELETE /api/shortlist/:id/notes ; GET /api/my-buyers?status&workspaceId
 */
export {
  DEFAULT_SHORTLIST_STATUS,
  EV_DRAFT_LEFT_PRODUCT,
  EV_PIPELINE_STATUS_CHANGED,
  SHORTLIST_STATUSES,
  STATUS_SOURCES,
} from './types.js';
export type {
  AddToShortlistDeniedDto,
  AddToShortlistResponseDto,
  DraftLeftProductPayload,
  MyBuyersResponseDto,
  Note,
  NoteDto,
  PipelineStatusChangedPayload,
  ShortlistEntry,
  ShortlistEntryDto,
  ShortlistListResponseDto,
  ShortlistStatus,
  StatusSource,
  UpdateShortlistStatusInput,
} from './types.js';

export { loadPipelineConfig, pipelineConfig, setPipelineConfig } from './config.js';
export type { PipelineConfig } from './config.js';

export {
  isShortlistStatus,
  parseCompanyIds,
  parseNextActionAt,
  parseNoteBody,
  parseNoteId,
  parseShortlistStatus,
  parseStatusPatch,
} from './validate.js';

export {
  addNote,
  addToShortlist,
  editNote,
  handleDraftLeftProduct,
  listWorkspaceShortlist,
  myBuyers,
  removeNote,
  updateShortlistStatus,
} from './service.js';

export { draftLeftProductSchema, registerPipelineModule, resetPipelineModuleForTesting } from './events.js';

export { registerPipelineRoutes } from './routes.js';
export type { PipelineRouteApp, PipelineRouteReply, PipelineRouteRequest } from './routes.js';

export { STATUS_LABELS_EN, statusLabel } from './labels.js';

export { StatusBadge } from './components/StatusBadge.js';
export type { StatusBadgeProps } from './components/StatusBadge.js';
