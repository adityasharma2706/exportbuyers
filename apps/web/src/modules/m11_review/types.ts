/**
 * M11 — shared types for the review queue (IF-11a file, IF-11b registerType).
 */
import type { z } from 'zod';
import type { Id } from '../m01_platform/index.js';
import type { Tx } from '../m02_queue/index.js';
import type { AdminRole } from '../m05_identity/index.js';

export type ReviewState = 'open' | 'in_review' | 'resolved' | 'rejected';
export const REVIEW_STATES: readonly ReviewState[] = ['open', 'in_review', 'resolved', 'rejected'];
export const ACTIVE_STATES: readonly ReviewState[] = ['open', 'in_review'];

export type FiledByKind = 'user' | 'system' | 'public';
export const FILED_BY_KINDS: readonly FiledByKind[] = ['user', 'system', 'public'];

export type HandlerResult = 'pending' | 'ok' | 'error';

export type ReviewAuditAction = 'filed' | 'claimed' | 'released' | 'resolved' | 'handler_ok' | 'handler_error';

/** A reference to the thing under review, e.g. `{kind: 'company', id: '<uuid>'}` or `{kind: 'job', id}`. */
export interface SubjectRef {
  kind: string;
  id: string;
}

export interface FiledBy {
  kind: FiledByKind;
  /** e.g. a member id for users, a module/job name for system, a hashed email for public forms. */
  ref?: string | null;
}

export interface ReviewItem<P = unknown> {
  id: Id<'review_item'>;
  type: string;
  subjectRefs: SubjectRef[];
  payload: P;
  filedBy: { kind: FiledByKind; ref: string | null };
  state: ReviewState;
  assignee: string | null;
  slaDueAt: Date;
  /** True while the item is open / in review and past its SLA. */
  slaBreached: boolean;
  outcome: string | null;
  outcomePayload: unknown;
  handlerResult: HandlerResult | null;
  handlerError: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  dedupeKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewAuditEntry {
  id: string;
  itemId: string;
  actor: string | null;
  action: ReviewAuditAction;
  before: unknown;
  after: unknown;
  at: Date;
}

/** How the admin console renders an item type. Labels are M04 message keys. */
export interface ConsoleViewField {
  /** Dot path into the item payload, e.g. `company.name`. */
  path: string;
  labelKey: string;
  format?: 'text' | 'url' | 'datetime' | 'json' | 'money' | 'email';
}

export interface ConsoleViewSpec {
  titleKey: string;
  fields: readonly ConsoleViewField[];
  /** Message keys for the outcome buttons, keyed by outcome. Missing keys fall back to the outcome name. */
  outcomeLabelKeys?: Readonly<Record<string, string>>;
  /** Outcomes that need a confirmation dialog in the console. */
  confirmOutcomes?: readonly string[];
}

export type ZodSchema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

export type OutcomeHandler<P, O> = (item: ReviewItem<P>, outcome: string, data: O, tx: Tx) => Promise<void>;

/** IF-11b definition. */
export interface ReviewTypeDef<P, O> {
  type: string;
  payloadSchema: ZodSchema<P>;
  outcomes: readonly string[];
  outcomeSchema: ZodSchema<O>;
  /** Default SLA; can be tuned at runtime with configureReviewSla(). */
  slaHours: number;
  view: ConsoleViewSpec;
  onOutcome: OutcomeHandler<P, O>;
  /**
   * Extension to the LLD signature: minimum admin role that may see, claim and resolve the
   * type (LLD M11 RBAC). Defaults to 'admin_super' so an unannotated type is never
   * over-exposed.
   */
  requiredRole?: AdminRole;
  /** Extension: outcomes that close the item as `rejected` rather than `resolved`. */
  rejectingOutcomes?: readonly string[];
}

export interface FileInput<P> {
  subjectRefs: readonly SubjectRef[];
  payload: P;
  filedBy: FiledBy;
  dedupeKey?: string;
}

/** EV-07 payload. Emitted as `review.outcome.<itemType>` so only the owning type's handler runs. */
export interface ReviewOutcomeEvent {
  v: 1;
  itemId: string;
  itemType: string;
  outcome: string;
}

export interface SlaBreachSummary {
  type: string;
  count: number;
  oldestDueAt: Date;
}

export type ReviewAlertSink = (breaches: readonly SlaBreachSummary[]) => Promise<void> | void;
