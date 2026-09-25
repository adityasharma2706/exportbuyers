/**
 * M07 — public types for tenancy, the business profile and product workspaces.
 */
import type { Id } from '../m01_platform/index.js';

export const EXPORT_EXPERIENCE = ['none', 'some', 'regular'] as const;
export type ExportExperience = (typeof EXPORT_EXPERIENCE)[number];

/** HS nomenclature levels (M11 `knowledge.hs_code.level`). */
export const HS_LEVELS = ['chapter', 'heading', 'subheading', 'national8'] as const;
export type HsLevel = (typeof HS_LEVELS)[number];

/** Number of digits for each HS level. */
export const HS_LEVEL_DIGITS: Readonly<Record<HsLevel, number>> = Object.freeze({
  chapter: 2,
  heading: 4,
  subheading: 6,
  national8: 8,
});

export interface BusinessProfile {
  accountId: Id<'account'>;
  businessName: string;
  city: string | null;
  state: string | null;
  whatTheyMake: string | null;
  exportExperience: ExportExperience | null;
  /** Importer-Exporter Code, uppercased, 10 alphanumerics. Verified later by M49 (REQ-003). */
  iec: string | null;
  iecVerifiedAt: Date | null;
  /** ISO-3166 alpha-2 codes. */
  targetMarkets: string[];
  senderName: string | null;
  senderEmail: string | null;
  website: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface HsSelection {
  code: string;
  level: HsLevel;
  version: string;
}

export interface Workspace {
  id: Id<'workspace'>;
  accountId: Id<'account'>;
  name: string;
  hs: HsSelection | null;
  /** Set by M40 when the HS version changes and the code needs re-confirmation. */
  hsNeedsReconfirm: boolean;
  /** Chosen markets, ISO-3166 alpha-2. */
  countries: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface OnboardingInput {
  businessName: string;
  city: string | null;
  state: string | null;
  whatTheyMake: string;
  exportExperience: ExportExperience;
  iec: string | null;
  targetMarkets: string[];
}

export interface OnboardingResult {
  workspaceId: Id<'workspace'>;
  /** False when onboarding had already been completed and the existing workspace is returned. */
  created: boolean;
}

/** PATCH /api/profile — every field is editable; `null` clears an optional field. */
export interface ProfilePatch {
  businessName?: string;
  city?: string | null;
  state?: string | null;
  whatTheyMake?: string | null;
  exportExperience?: ExportExperience | null;
  iec?: string | null;
  targetMarkets?: string[];
  senderName?: string | null;
  senderEmail?: string | null;
  website?: string | null;
}

export interface WorkspaceCreateInput {
  name: string;
  hs?: HsSelection | null;
  countries?: string[];
}

export interface WorkspacePatch {
  name?: string;
  countries?: string[];
}

/** Anonymous work carried over at sign-in (M05 `anon_state_pending`). */
export interface AnonCarryOver {
  hs: HsSelection | null;
  countries: string[];
}
