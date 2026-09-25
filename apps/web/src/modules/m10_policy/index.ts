/**
 * M10 Global suppression list and Visibility & Policy layer — public API. Other modules import
 * ONLY from this file. Every read path (search, profile, reveal, draft, export, notifications,
 * alerts, similar) must go through IF-10a; nothing else may read the knowledge read models.
 *
 * IF-10a search(ctx, surface, q), byIds(ctx, surface, ids), assertAllowed(ctx, surface, id, action),
 *        matchByIdentifiers(ctx, {domain?, email?})
 * IF-10b registerProvider('userHides' | 'entitlements', p)
 * IF-10c isSuppressed(kind, raw), normHash(kind, raw), anySuppressed(hashes)
 * IF-10d suppress(tx, entries, reason, reviewItemId?)  — emits EV-04 in tx
 *
 * Rule order: global suppression → sanctions (visible with warning; view only) → licence →
 * region / personal data → logistics default hide → per-user hides → plan entitlements.
 */
export type {
  Action,
  AnonymousSearchPreview,
  ByIdsEntry,
  ByIdsOptions,
  DocFact,
  EntitlementsProvider,
  IdentifierKind,
  PolicyDecision,
  ProfileDoc,
  ProviderKind,
  ReasonCode,
  SearchDoc,
  SearchQuery,
  SearchResult,
  SearchResultRow,
  Surface,
  SuppressionReason,
  TrustLevel,
  UserHidesProvider,
  Visibility,
} from './types.js';
export { ALL_ACTIONS, IDENTIFIER_KINDS, SURFACES, SUPPRESSION_REASONS } from './types.js';
export { assertAllowed, byIds, matchByIdentifiers, search, searchQuerySchema } from './policy.js';
export { configurePolicy, loadPolicyConfigFromEnv, policyConfig, registerProvider, resetProvidersForTesting } from './providers.js';
export type { PolicyConfig } from './providers.js';
export { anySuppressed, EV_SUPPRESSION_ADDED, isSuppressed, suppress } from './suppression.js';
export type { SuppressionEntry } from './suppression.js';
export { isIdentifierKind, normalise, normHash } from './normalise.js';
export { bumpPolicyGen, invalidateAccountPolicyCache } from './cache.js';
export { EV_SANCTIONS_FLAG_CHANGED, EV_SUBSCRIPTION_CHANGED, purgeSuppressed, registerPolicyJobs } from './jobs.js';
export { permits } from './rules.js';
