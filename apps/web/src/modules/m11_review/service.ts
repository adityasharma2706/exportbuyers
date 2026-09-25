/**
 * M11 — review queue core.
 *
 *   IF-11a file(tx, type, {subjectRefs, payload, filedBy, dedupeKey?}) → item id (existing id on a dedupe hit)
 *   IF-11b registerType(def)
 *   Console operations: listItems, getItem, claimItem, releaseItem, resolveItem.
 *
 * resolve writes the audit row, sets the state and emits EV-07 in one transaction. EV-07 is
 * emitted as `review.outcome.<itemType>`; the type's registered onOutcome runs as that event's
 * handler (inside the handler transaction supplied by M02). A failing handler is retried by
 * the queue and the item shows handler_result='error' in the console meanwhile.
 */
import { sql } from 'kysely';
import { z } from 'zod';
import { AppError, isUuid, log, newId, systemDb, type ActorContext, type Id } from '../m01_platform/index.js';
import {
  NonRetryable,
  emit,
  registerEventSchema,
  subscribe,
  type EventMeta,
  type Tx,
} from '../m02_queue/index.js';
import { requireAdmin, type AdminRole } from '../m05_identity/index.js';
import {
  ADMIN_ROLE_RANK,
  addType,
  getType,
  registeredTypes,
  requireType,
  requiredRoleOf,
  roleMayHandle,
  slaDueAt,
  slaHoursFor,
  typesVisibleTo,
  type AnyReviewTypeDef,
} from './registry.js';
import {
  findActiveByDedupe,
  getItemRow,
  insertAudit,
  insertItem,
  listAudit,
  listItemRows,
  rowToItem,
  setClaimed,
  setHandlerResult,
  setResolved,
  type ReviewItemRow,
} from './repo.js';
import {
  ACTIVE_STATES,
  FILED_BY_KINDS,
  REVIEW_STATES,
  type ConsoleViewSpec,
  type FileInput,
  type ReviewAuditEntry,
  type ReviewItem,
  type ReviewOutcomeEvent,
  type ReviewState,
  type ReviewTypeDef,
} from './types.js';

export const EV_REVIEW_OUTCOME_PREFIX = 'review.outcome.';
export const OUTCOME_HANDLER_NAME = 'm11.outcome';

/** EV-07 event type for an item type. */
export function reviewOutcomeEventType(itemType: string): string {
  return `${EV_REVIEW_OUTCOME_PREFIX}${itemType}`;
}

const reviewOutcomeEventSchema = z.object({
  v: z.literal(1),
  itemId: z.string().uuid(),
  itemType: z.string().min(1).max(100),
  outcome: z.string().min(1).max(64),
});

const MAX_SUBJECT_REFS = 50;
const MAX_ERROR_LEN = 2000;

function errorText(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.length > MAX_ERROR_LEN ? `${s.slice(0, MAX_ERROR_LEN - 1)}…` : s;
}

// ---------------------------------------------------------------------------------------
// IF-11b registerType
// ---------------------------------------------------------------------------------------

/**
 * Registers an item type: its payload/outcome schemas, console view, SLA and outcome handler.
 * Must be called at module load / boot, before M02's syncRegistrations(), because it subscribes
 * the handler to the type's EV-07 event.
 */
export function registerType<P, O>(def: ReviewTypeDef<P, O>): void {
  addType(def as AnyReviewTypeDef);
  const eventType = reviewOutcomeEventType(def.type);
  registerEventSchema(eventType, reviewOutcomeEventSchema);
  subscribe(eventType, OUTCOME_HANDLER_NAME, async (payload: unknown, meta: EventMeta) => {
    await runOutcomeHandler(def as AnyReviewTypeDef, payload as ReviewOutcomeEvent, meta);
  });
}

/** Records handler_result='error' outside the failing handler transaction (which rolls back). */
async function recordHandlerError(itemId: string, err: unknown, attempt: number, maxAttempts: number): Promise<void> {
  const message = errorText(err);
  try {
    await systemDb('m11 record outcome handler error')
      .transaction()
      .execute(async (tx: Tx) => {
        // The handler transaction is still open; never wait long on a lock it might hold.
        await sql`set local lock_timeout = '2s'`.execute(tx);
        await setHandlerResult(tx, itemId, 'error', message);
        await insertAudit(tx, { itemId, actor: null, action: 'handler_error', before: null, after: { error: message, attempt, maxAttempts } });
      });
  } catch (e) {
    log.error({ err: e, itemId }, 'm11 could not record outcome handler error');
  }
}

async function runOutcomeHandler(def: AnyReviewTypeDef, ev: ReviewOutcomeEvent, meta: EventMeta): Promise<void> {
  const tx = meta.tx;
  const row = await getItemRow(tx, ev.itemId);
  if (!row) throw new NonRetryable(`review item ${ev.itemId} not found`);
  if (row.type !== def.type) throw new NonRetryable(`review item ${ev.itemId} has type ${row.type}, event is for ${def.type}`);
  if ((row.state !== 'resolved' && row.state !== 'rejected') || row.outcome !== ev.outcome) {
    log.warn({ itemId: row.id, state: row.state, outcome: row.outcome, eventOutcome: ev.outcome }, 'm11 outcome event does not match item; skipping');
    return;
  }
  if (row.handler_result === 'ok') return;

  const item = rowToItem(row);
  const p = def.payloadSchema.safeParse(item.payload);
  if (!p.success) {
    const err = new NonRetryable(`stored payload no longer matches the ${def.type} schema: ${p.error.message}`);
    await recordHandlerError(row.id, err, meta.job.attempt, meta.job.maxAttempts);
    throw err;
  }
  const o = def.outcomeSchema.safeParse(item.outcomePayload ?? {});
  if (!o.success) {
    const err = new NonRetryable(`stored outcome data does not match the ${def.type} outcome schema: ${o.error.message}`);
    await recordHandlerError(row.id, err, meta.job.attempt, meta.job.maxAttempts);
    throw err;
  }

  try {
    await def.onOutcome({ ...item, payload: p.data }, ev.outcome, o.data, tx);
  } catch (e) {
    log.error({ err: e, itemId: row.id, type: def.type, outcome: ev.outcome, attempt: meta.job.attempt }, 'm11 outcome handler failed');
    await recordHandlerError(row.id, e, meta.job.attempt, meta.job.maxAttempts);
    throw e;
  }
  await setHandlerResult(tx, row.id, 'ok', null);
  await insertAudit(tx, { itemId: row.id, actor: null, action: 'handler_ok', before: null, after: { outcome: ev.outcome } });
}

// ---------------------------------------------------------------------------------------
// IF-11a file
// ---------------------------------------------------------------------------------------

function validateFileInput(type: string, input: FileInput<unknown>): void {
  if (!input || typeof input !== 'object') throw new AppError('VALIDATION', `file(${type}): input is required`);
  if (!Array.isArray(input.subjectRefs) || input.subjectRefs.length > MAX_SUBJECT_REFS) {
    throw new AppError('VALIDATION', `file(${type}): subjectRefs must be an array of at most ${MAX_SUBJECT_REFS}`);
  }
  input.subjectRefs.forEach((r, i) => {
    if (!r || typeof r.kind !== 'string' || !/^[a-z][a-z0-9_.]{0,49}$/.test(r.kind) || typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 200) {
      throw new AppError('VALIDATION', `file(${type}): subjectRefs[${i}] must be {kind, id}`, { index: i });
    }
  });
  if (!input.filedBy || !FILED_BY_KINDS.includes(input.filedBy.kind)) {
    throw new AppError('VALIDATION', `file(${type}): filedBy.kind must be one of ${FILED_BY_KINDS.join(', ')}`);
  }
  const ref = input.filedBy.ref;
  if (ref !== undefined && ref !== null && (typeof ref !== 'string' || ref.length > 200)) {
    throw new AppError('VALIDATION', `file(${type}): filedBy.ref must be a string of at most 200 chars`);
  }
  if (input.dedupeKey !== undefined && (typeof input.dedupeKey !== 'string' || input.dedupeKey.length === 0 || input.dedupeKey.length > 400)) {
    throw new AppError('VALIDATION', `file(${type}): dedupeKey must be 1..400 chars`);
  }
}

/**
 * IF-11a. Files a review item inside the caller's transaction. With a dedupeKey, an active
 * (open or in_review) item of the same type and key is returned instead of a new one.
 */
export async function file<P>(tx: Tx, type: string, input: FileInput<P>): Promise<Id<'review_item'>> {
  const def = requireType(type);
  validateFileInput(type, input as FileInput<unknown>);
  const parsed = def.payloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    throw new AppError('VALIDATION', `file(${type}): payload failed schema validation`, { issues: parsed.error.message });
  }
  const payload: unknown = parsed.data;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('VALIDATION', `file(${type}): payload must be a JSON object`);
  }
  const dedupeKey = input.dedupeKey ?? null;
  const filedByRef = input.filedBy.ref ?? null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newId<'review_item'>();
    const created = await insertItem(tx, {
      id,
      type,
      subjectRefs: input.subjectRefs.map((r) => ({ kind: r.kind, id: r.id })),
      payload,
      filedByKind: input.filedBy.kind,
      filedByRef,
      slaDueAt: slaDueAt(def),
      dedupeKey,
    });
    if (created) {
      const actor = input.filedBy.kind === 'user' && filedByRef !== null && isUuid(filedByRef) ? filedByRef : null;
      await insertAudit(tx, {
        itemId: created,
        actor,
        action: 'filed',
        before: null,
        after: { state: 'open', filedBy: { kind: input.filedBy.kind, ref: filedByRef }, slaHours: slaHoursFor(def) },
      });
      log.info({ itemId: created, type, filedByKind: input.filedBy.kind }, 'm11 review item filed');
      return created as Id<'review_item'>;
    }
    if (dedupeKey === null) throw new AppError('INTERNAL', `file(${type}): insert returned no row`);
    const existing = await findActiveByDedupe(tx, type, dedupeKey);
    if (existing) {
      log.debug({ itemId: existing, type }, 'm11 review item dedupe hit');
      return existing as Id<'review_item'>;
    }
    // The conflicting item was closed between the insert and the lookup; try again.
  }
  throw new AppError('CONFLICT', `file(${type}): could not file item after repeated dedupe races`);
}

// ---------------------------------------------------------------------------------------
// Console operations (admin, RBAC + MFA via M05 requireAdmin)
// ---------------------------------------------------------------------------------------

export interface ReviewTypeInfo {
  type: string;
  outcomes: readonly string[];
  rejectingOutcomes: readonly string[];
  slaHours: number;
  requiredRole: AdminRole;
  view: ConsoleViewSpec;
}

function typeInfo(def: AnyReviewTypeDef): ReviewTypeInfo {
  return {
    type: def.type,
    outcomes: def.outcomes,
    rejectingOutcomes: def.rejectingOutcomes ?? [],
    slaHours: slaHoursFor(def),
    requiredRole: requiredRoleOf(def),
    view: def.view,
  };
}

function adminActor(ctx: ActorContext): { role: AdminRole; memberId: string } {
  const role = requireAdmin(ctx, 'admin_support');
  if (!ctx.memberId || !isUuid(ctx.memberId)) throw new AppError('UNAUTHENTICATED', 'Admin session has no member');
  return { role, memberId: ctx.memberId };
}

/** RBAC for a stored item. Unregistered types are visible to admin_super only. */
function assertMayHandle(role: AdminRole, row: ReviewItemRow): AnyReviewTypeDef | undefined {
  const def = getType(row.type);
  const allowed = def ? roleMayHandle(role, def) : role === 'admin_super';
  if (!allowed) throw new AppError('FORBIDDEN', 'Insufficient admin role for this review item', { type: row.type });
  return def;
}

function adminDb(ctx: ActorContext, reason: string): Tx {
  return systemDb(reason, ctx);
}

const listQuerySchema = z.object({
  type: z.string().max(1000).optional(),
  state: z.string().max(200).optional(),
  mine: z.enum(['true', 'false', '1', '0']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return [...new Set(v.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
}

export interface ListResult {
  items: ReviewItem[];
  total: number;
  limit: number;
  offset: number;
  types: ReviewTypeInfo[];
}

/** GET /admin/review?type&state[&mine&limit&offset] */
export async function listItems(ctx: ActorContext, query: unknown): Promise<ListResult> {
  const { role, memberId } = adminActor(ctx);
  const q = listQuerySchema.safeParse(query ?? {});
  if (!q.success) throw new AppError('VALIDATION', 'Invalid review query', { issues: q.error.message });

  const visible = typesVisibleTo(role);
  const unregisteredVisible = role === 'admin_super';
  let types = splitList(q.data.type);
  if (types.length > 0) {
    for (const t of types) {
      const def = getType(t);
      const ok = def ? roleMayHandle(role, def) : unregisteredVisible;
      if (!ok) throw new AppError('FORBIDDEN', 'Insufficient admin role for this review type', { type: t });
    }
  } else {
    types = visible;
  }

  const stateList = splitList(q.data.state);
  for (const s of stateList) {
    if (!REVIEW_STATES.includes(s as ReviewState)) throw new AppError('VALIDATION', `Unknown state "${s}"`, { field: 'state' });
  }
  const states = (stateList.length > 0 ? stateList : ACTIVE_STATES) as ReviewState[];
  const mine = q.data.mine === 'true' || q.data.mine === '1';

  const db = adminDb(ctx, 'm11 review console list');
  const res = await listItemRows(db, {
    types,
    states,
    ...(mine ? { assignee: memberId } : {}),
    limit: q.data.limit,
    offset: q.data.offset,
  });
  const now = new Date();
  return {
    items: res.rows.map((r) => rowToItem(r, now)),
    total: res.total,
    limit: q.data.limit,
    offset: q.data.offset,
    types: registeredTypes().filter((d) => roleMayHandle(role, d)).map(typeInfo),
  };
}

function assertItemId(id: unknown): string {
  if (typeof id !== 'string' || !isUuid(id)) throw new AppError('NOT_FOUND', 'Review item not found');
  return id;
}

/** GET /admin/review/:id — item, its type's console view, and the audit trail. */
export async function getItem(
  ctx: ActorContext,
  id: unknown,
): Promise<{ item: ReviewItem; type: ReviewTypeInfo | null; audit: ReviewAuditEntry[] }> {
  const { role } = adminActor(ctx);
  const itemId = assertItemId(id);
  const db = adminDb(ctx, 'm11 review console item');
  const row = await getItemRow(db, itemId);
  if (!row) throw new AppError('NOT_FOUND', 'Review item not found');
  const def = assertMayHandle(role, row);
  const audit = await listAudit(db, itemId);
  return { item: rowToItem(row), type: def ? typeInfo(def) : null, audit };
}

/** POST /admin/review/:id/claim — open → in_review, assigned to the caller. Idempotent for the assignee. */
export async function claimItem(ctx: ActorContext, id: unknown): Promise<ReviewItem> {
  const { role, memberId } = adminActor(ctx);
  const itemId = assertItemId(id);
  return adminDb(ctx, 'm11 review claim')
    .transaction()
    .execute(async (tx: Tx) => {
      const row = await getItemRow(tx, itemId, true);
      if (!row) throw new AppError('NOT_FOUND', 'Review item not found');
      assertMayHandle(role, row);
      if (row.state === 'resolved' || row.state === 'rejected') {
        throw new AppError('CONFLICT', 'Review item is already closed', { state: row.state });
      }
      if (row.state === 'in_review') {
        if (row.assignee === memberId) return rowToItem(row);
        throw new AppError('CONFLICT', 'Review item is claimed by another admin', { assignee: row.assignee });
      }
      await setClaimed(tx, itemId, memberId, 'in_review');
      await insertAudit(tx, {
        itemId,
        actor: memberId,
        action: 'claimed',
        before: { state: row.state, assignee: row.assignee },
        after: { state: 'in_review', assignee: memberId },
      });
      const fresh = await getItemRow(tx, itemId);
      return rowToItem(fresh ?? row);
    });
}

/** POST /admin/review/:id/release — in_review → open. The assignee or an admin_super may release. */
export async function releaseItem(ctx: ActorContext, id: unknown): Promise<ReviewItem> {
  const { role, memberId } = adminActor(ctx);
  const itemId = assertItemId(id);
  return adminDb(ctx, 'm11 review release')
    .transaction()
    .execute(async (tx: Tx) => {
      const row = await getItemRow(tx, itemId, true);
      if (!row) throw new AppError('NOT_FOUND', 'Review item not found');
      assertMayHandle(role, row);
      if (row.state !== 'in_review') throw new AppError('CONFLICT', 'Only an item in review can be released', { state: row.state });
      if (row.assignee !== memberId && role !== 'admin_super') {
        throw new AppError('FORBIDDEN', 'Only the assignee or a super admin can release this item');
      }
      await setClaimed(tx, itemId, null, 'open');
      await insertAudit(tx, {
        itemId,
        actor: memberId,
        action: 'released',
        before: { state: row.state, assignee: row.assignee },
        after: { state: 'open', assignee: null },
      });
      const fresh = await getItemRow(tx, itemId);
      return rowToItem(fresh ?? row);
    });
}

const resolveBodySchema = z.object({
  outcome: z.string().min(1).max(64),
  data: z.unknown().optional(),
});

/**
 * POST /admin/review/:id/resolve {outcome, data}. Writes the audit row, sets the state and emits
 * EV-07 in one transaction. The outcome handler runs asynchronously as the EV-07 handler.
 */
export async function resolveItem(ctx: ActorContext, id: unknown, body: unknown): Promise<ReviewItem> {
  const { role, memberId } = adminActor(ctx);
  const itemId = assertItemId(id);
  const b = resolveBodySchema.safeParse(body ?? {});
  if (!b.success) throw new AppError('VALIDATION', 'Invalid resolve request', { issues: b.error.message });

  return adminDb(ctx, 'm11 review resolve')
    .transaction()
    .execute(async (tx: Tx) => {
      const row = await getItemRow(tx, itemId, true);
      if (!row) throw new AppError('NOT_FOUND', 'Review item not found');
      assertMayHandle(role, row);
      const def = requireType(row.type);
      if (row.state === 'resolved' || row.state === 'rejected') {
        throw new AppError('CONFLICT', 'Review item is already closed', { state: row.state, outcome: row.outcome });
      }
      if (row.state === 'in_review' && row.assignee !== memberId && ADMIN_ROLE_RANK[role] < ADMIN_ROLE_RANK.admin_super) {
        throw new AppError('CONFLICT', 'Review item is claimed by another admin', { assignee: row.assignee });
      }
      const outcome = b.data.outcome;
      if (!def.outcomes.includes(outcome)) {
        throw new AppError('VALIDATION', `Unknown outcome "${outcome}" for ${def.type}`, { field: 'outcome', allowed: [...def.outcomes] });
      }
      const data = def.outcomeSchema.safeParse(b.data.data ?? {});
      if (!data.success) {
        throw new AppError('VALIDATION', 'Outcome data failed validation', { field: 'data', issues: data.error.message });
      }
      const state: 'resolved' | 'rejected' = (def.rejectingOutcomes ?? []).includes(outcome) ? 'rejected' : 'resolved';

      await setResolved(tx, itemId, { state, outcome, outcomePayload: data.data ?? null, resolvedBy: memberId, assignee: memberId });
      await insertAudit(tx, {
        itemId,
        actor: memberId,
        action: 'resolved',
        before: { state: row.state, assignee: row.assignee },
        after: { state, outcome, data: data.data ?? null, role },
      });
      const ev: ReviewOutcomeEvent = { v: 1, itemId, itemType: def.type, outcome };
      await emit(tx, reviewOutcomeEventType(def.type), ev);
      log.info({ itemId, type: def.type, outcome, state, memberId }, 'm11 review item resolved');
      const fresh = await getItemRow(tx, itemId);
      if (!fresh) throw new AppError('INTERNAL', 'Review item vanished during resolve');
      return rowToItem(fresh);
    });
}
