/**
 * M27 — pluggable extension points for facts owned by modules that do not exist yet
 * (docs/implementer.md lists M27's own deps as only M10, M24, M26 — none of M29/M32/M33/M34).
 *
 * The LLD's M27 entry nonetheless commits the wire contract to three fields those later modules
 * own: "Red flags come from M32.evaluateContextual(profile)", "revealed" (M29's reveal ledger) and
 * a reserved shortlist-entry shape for drafts, notes and status that M33/M34 will fill once they
 * exist. Rather than hard-code a forward dependency M27 was not given, or leave the field out of
 * the response, this follows M10's own
 * `registerProvider('userHides' | 'entitlements', p)` pattern (IF-10b): a typed registration point
 * with a safe default (no red flags, not revealed, no shortlist entry) that the later module wires
 * up when it lands, with no change needed here.
 *
 * [deviation: LLD M27 names M32 directly for red flags; here that dependency is inverted into a
 * provider so M27's own module boundary (M10, M24, M26) is not silently widened.]
 */
import { log, type ActorContext } from '../m01_platform/index.js';
import type { ProfileDoc } from '../m10_policy/index.js';
import type { RedFlagDto, ShortlistEntryDto } from './types.js';

export interface RedFlagsProvider {
  /** M32 IF-32-ish: `evaluateContextual(profile)` — red flags in the context of a known company. */
  evaluateContextual(ctx: ActorContext, profile: ProfileDoc): Promise<RedFlagDto[]> | RedFlagDto[];
}

export interface ShortlistProvider {
  /** M33/M34: the workspace's shortlist entry (status/notes/drafts) for this company, or null. */
  entryFor(ctx: ActorContext, workspaceId: string, companyId: string): Promise<ShortlistEntryDto | null> | ShortlistEntryDto | null;
}

export interface RevealedProvider {
  /** M29: whether this account already holds a `done` reveal for this company. */
  isRevealed(ctx: ActorContext, companyId: string): Promise<boolean> | boolean;
}

export type ProfileProviderKind = 'redFlags' | 'shortlist' | 'revealed';

interface Providers {
  redFlags: RedFlagsProvider | null;
  shortlist: ShortlistProvider | null;
  revealed: RevealedProvider | null;
}

const providers: Providers = { redFlags: null, shortlist: null, revealed: null };

export function registerProvider(kind: 'redFlags', p: RedFlagsProvider): void;
export function registerProvider(kind: 'shortlist', p: ShortlistProvider): void;
export function registerProvider(kind: 'revealed', p: RevealedProvider): void;
export function registerProvider(kind: ProfileProviderKind, p: RedFlagsProvider | ShortlistProvider | RevealedProvider): void {
  switch (kind) {
    case 'redFlags':
      providers.redFlags = p as RedFlagsProvider;
      return;
    case 'shortlist':
      providers.shortlist = p as ShortlistProvider;
      return;
    case 'revealed':
      providers.revealed = p as RevealedProvider;
      return;
  }
}

/** For tests. */
export function resetProvidersForTesting(): void {
  providers.redFlags = null;
  providers.shortlist = null;
  providers.revealed = null;
}

/** LLD M27 rule: "Red flags come from M32.evaluateContextual(profile)." Empty until M32 registers;
 * a failing provider must never break the profile page, so errors are swallowed to `[]`. */
export async function evaluateRedFlags(ctx: ActorContext, profile: ProfileDoc): Promise<RedFlagDto[]> {
  if (!providers.redFlags) return [];
  try {
    return [...(await providers.redFlags.evaluateContextual(ctx, profile))];
  } catch (err) {
    log.warn({ err, companyId: profile.company_id }, 'm27: red flags provider failed; showing none');
    return [];
  }
}

/** False (never revealed) until M29 registers. */
export async function isRevealed(ctx: ActorContext, companyId: string): Promise<boolean> {
  if (!providers.revealed) return false;
  try {
    return await providers.revealed.isRevealed(ctx, companyId);
  } catch (err) {
    log.warn({ err, companyId }, 'm27: revealed provider failed; assuming not revealed');
    return false;
  }
}

/** Undefined (omit `shortlistEntry`) until M33/M34 register, or when no workspace applies. */
export async function shortlistEntryFor(
  ctx: ActorContext,
  workspaceId: string | null,
  companyId: string,
): Promise<ShortlistEntryDto | undefined> {
  if (!providers.shortlist || !workspaceId) return undefined;
  try {
    const entry = await providers.shortlist.entryFor(ctx, workspaceId, companyId);
    return entry ?? undefined;
  } catch (err) {
    log.warn({ err, companyId, workspaceId }, 'm27: shortlist provider failed; omitting shortlistEntry');
    return undefined;
  }
}
