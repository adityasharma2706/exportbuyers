/**
 * M07 Tenancy, business profile and onboarding — public API. Other modules import ONLY from this file.
 *
 * IF-07a getWorkspace(ctx, id), listWorkspaces(ctx), setHsCode(ctx, id, {code, level, version}),
 *        setCountries(ctx, id, countries) — plus create / rename / delete / withWorkspace
 * IF-07b getBusinessProfile(ctx)
 * Routes POST /api/onboarding; GET|PATCH /api/profile; GET|POST /api/workspaces;
 *        GET|PATCH|DELETE /api/workspaces/:id
 * Jobs   m07.purge_workspaces (daily hard purge of soft-deleted workspaces after 30 days)
 * IF-38a exportTenancy(accountId), eraseTenancy(accountId)
 */
export { EXPORT_EXPERIENCE, HS_LEVELS, HS_LEVEL_DIGITS } from './types.js';
export type {
  AnonCarryOver,
  BusinessProfile,
  ExportExperience,
  HsLevel,
  HsSelection,
  OnboardingInput,
  OnboardingResult,
  ProfilePatch,
  Workspace,
  WorkspaceCreateInput,
  WorkspacePatch,
} from './types.js';

export { loadTenancyConfig, setTenancyConfig, tenancyConfig } from './config.js';
export type { TenancyConfig } from './config.js';

export {
  completeOnboarding,
  createWorkspace,
  deleteWorkspace,
  findBusinessProfile,
  getBusinessProfile,
  getWorkspace,
  listWorkspaces,
  rememberAnonymousSelection,
  renameWorkspace,
  setCountries,
  setHsCode,
  updateBusinessProfile,
  updateWorkspace,
  withWorkspace,
} from './tenancy.js';

export {
  defaultWorkspaceName,
  hsLevelForCode,
  normaliseIec,
  parseCountries,
  parseHsSelection,
  parseOnboarding,
  parseProfilePatch,
  parseWorkspaceCreate,
  parseWorkspacePatch,
} from './validate.js';

export type { BusinessProfileRow, WorkspaceRow } from './repo.js';

export { PURGE_WORKSPACES_JOB, registerTenancyJobs, runWorkspacePurge } from './jobs.js';
export { eraseTenancy, exportTenancy } from './dataRights.js';
export type { TenancyExport } from './dataRights.js';

export { profileDto, registerTenancyRoutes, workspaceDto } from './routes.js';
export type { TenancyRouteApp, TenancyRouteReply, TenancyRouteRequest } from './routes.js';
