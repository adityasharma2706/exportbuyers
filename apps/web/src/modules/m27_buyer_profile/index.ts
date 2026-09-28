/**
 * M27 Buyer profile (API + UI) — public API. Other modules import ONLY from this file.
 *
 * REQ-021 (profile page: overview, evidence, activity, sourcing, website, trust, contacts, and a
 * reserved drafts/notes/status section awaiting M33/M34), REQ-017 ("why this buyer" evidence with
 * source type + date),
 * REQ-022 (India/competitor sourcing where data allows), REQ-024 (lower-confidence handling is
 * M26's; this module just carries the doc through), REQ-027/REQ-028 (trust checklist + rollup +
 * disclaimer), REQ-029 (prominent sanctions warning; reveal/draft disabled with an explanation).
 *
 * IF-27a  GET /api/buyers/:companyId?workspaceId=
 */
export type {
  ActivityItemDto,
  BuyerProfileResponseDto,
  BuyerTypeDto,
  ContactTypeDto,
  EvidenceItemDto,
  ProfileActionDto,
  ProfileActionsDto,
  ProfileDto,
  RedFlagDto,
  RedFlagSeverity,
  ShortlistEntryDto,
  SourcingDto,
  SourcingFlag,
  TrustCheckItemDto,
  TrustDto,
  TrustLevelValue,
  TrustOutcomeValue,
} from './types.js';
export { PROFILE_DISCLAIMER_KEY, SANCTIONS_DISCLAIMER_KEY } from './types.js';

export { toProfileDto } from './dto.js';

export {
  evaluateRedFlags,
  isRevealed,
  registerProvider,
  resetProvidersForTesting,
  shortlistEntryFor,
} from './providers.js';
export type { ProfileProviderKind, RedFlagsProvider, RevealedProvider, ShortlistProvider } from './providers.js';

export { getBuyerProfile } from './service.js';

export { registerBuyerProfileRoutes } from './routes.js';
export type { BuyerProfileRouteApp, BuyerProfileRouteReply, BuyerProfileRouteRequest } from './routes.js';

export {
  BUYER_PROFILE_MESSAGES_EN,
  BUYER_PROFILE_NAMESPACE,
  actionBlockedLabel,
  fillLabel,
  resolveBuyerProfileLabels,
} from './labels.js';
export type { BuyerProfileLabelKey, BuyerProfileLabels } from './labels.js';

export { BuyerProfile } from './components/BuyerProfile.js';
export type { BuyerProfileProps, RevealedContactUi } from './components/BuyerProfile.js';
