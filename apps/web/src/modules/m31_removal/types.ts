/**
 * M31 Public removal and correction page — shared types (LLD M31 "API (IF-31a)" / "Outcomes").
 */

export type RemovalKind = 'removal' | 'correction';
export const REMOVAL_KINDS: readonly RemovalKind[] = ['removal', 'correction'];

export type IdentityCheck = 'ok' | 'needs_identity_check';
export const IDENTITY_CHECKS: readonly IdentityCheck[] = ['ok', 'needs_identity_check'];

/** IF-31a `identifiers` — as the visitor typed them. */
export interface RemovalIdentifiersInput {
  domain?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  country?: string;
}

/** The same shape, after M10 normalisation (domain/email/phone) and light trimming
 * (companyName/country). Empty keys are omitted, never `null` or `''`. */
export interface NormalisedIdentifiers {
  domain?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  country?: string;
}

// ---- serving.public_removal_challenge row shape --------------------------------------------

export interface RemovalChallengeRow {
  id: string;
  kind: RemovalKind;
  requesterEmail: string;
  identifiers: NormalisedIdentifiers;
  matchedCompanyId: string | null;
  identityCheck: IdentityCheck;
  details: string | null;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  reviewItemId: string | null;
  createdAt: Date;
}

// ---- M11 'removal.request' review item payload (LLD M31) -----------------------------------

export interface RemovalRequestPayload {
  kind: RemovalKind;
  requesterEmail: string;
  identifiers: NormalisedIdentifiers;
  matchedCompanyId: string | null;
  details: string | null;
  /** LLD M31 Rules: "Otherwise the item is flagged needs_identity_check for the operator; it is
   * still filed." */
  identityCheck: IdentityCheck;
}

export type RemovalOutcome = 'approve_removal' | 'approve_correction' | 'reject';
export const REMOVAL_OUTCOMES: readonly RemovalOutcome[] = ['approve_removal', 'approve_correction', 'reject'];

/** Union of the `data` shapes the three outcomes need (LLD "Outcomes":
 * `approve_correction {attribute, value}`, `reject {reasonKey}`; `approve_removal` needs none). */
export interface RemovalOutcomeData {
  attribute?: string;
  value?: Record<string, unknown>;
  reasonKey?: string;
}

// ---- IF-31a wire DTOs ------------------------------------------------------------------------

export interface RequestRemovalRequest {
  requesterEmail: string;
  kind: RemovalKind;
  identifiers: RemovalIdentifiersInput;
  details?: string;
  turnstileToken: string;
}

export interface RequestRemovalResponseDto {
  sent: true;
  expiresInHours: number;
}

export interface VerifyRemovalResponseDto {
  filed: true;
  itemId: string;
  /** True when the token had already been used (a re-click of the same email link). */
  alreadyProcessed: boolean;
}
