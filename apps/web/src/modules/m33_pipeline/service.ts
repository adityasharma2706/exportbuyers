/**
 * M33 — pipeline server side (IF-33a). REQ-045 (shortlist add, single/bulk), REQ-046 (status),
 * REQ-008 (workspace-scoped shortlists), REQ-047 (notes part).
 *
 *   addToShortlist(ctx, workspaceId, body)     POST /api/workspaces/:ws/shortlist
 *   updateShortlistStatus(ctx, id, body)       PATCH /api/shortlist/:id
 *   addNote / editNote / removeNote            POST/PATCH/DELETE /api/shortlist/:id/notes
 *   listWorkspaceShortlist(ctx, ws, status)    GET /api/workspaces/:ws/shortlist?status
 *   myBuyers(ctx, status, workspaceId)         GET /api/my-buyers?status&workspaceId
 *
 * LLD Rules: "Adding runs M10.byIds(ctx,'profile',ids). Hidden companies are denied.
 * Sanctions-flagged companies are allowed, and they carry a warning." / "Any status transition
 * is allowed ... Setting the same status is a no-op. Each change writes history and emits
 * EV-08." / "Reads resolve company ids through the redirect view. Two entries that merge into
 * the same company are both shown, with a 'duplicate' hint."
 */
import { AppError, log, requireMember, scoped, systemDb, withSpan, type ActorContext, type Id } from '../m01_platform/index.js';
import { getWorkspace } from '../m07_tenancy/index.js';
import { byIds, type PolicyDecision } from '../m10_policy/index.js';
import { emit, type Tx } from '../m02_queue/index.js';
import {
  applyAutoContactedIfToContact,
  deleteNote,
  findEntryById,
  insertEntryIfAbsent,
  insertNote,
  insertStatusHistory,
  listEntries,
  notesCountByEntry,
  updateEntry,
  updateNote,
} from './repo.js';
import {
  objectBody,
  parseCompanyIds,
  parseEntryIdParam,
  parseNoteBody,
  parseNoteId,
  parseStatusPatch,
  parseStatusQuery,
  parseWorkspaceIdParam,
  parseWorkspaceIdQuery,
} from './validate.js';
import {
  EV_PIPELINE_STATUS_CHANGED,
  type AddToShortlistDeniedDto,
  type AddToShortlistResponseDto,
  type MyBuyersResponseDto,
  type Note,
  type NoteDto,
  type PipelineStatusChangedPayload,
  type ShortlistEntry,
  type ShortlistEntryDto,
  type ShortlistListResponseDto,
  type ShortlistStatus,
} from './types.js';

// ---- helpers --------------------------------------------------------------------------------

function entryNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Shortlist entry not found');
}

function noteNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Note not found');
}

function toNoteDto(n: Note): NoteDto {
  return { id: n.id, entryId: n.entryId, body: n.body, createdAt: n.createdAt.toISOString(), updatedAt: n.updatedAt.toISOString() };
}

interface DtoExtras {
  companyId: string;
  sanctionsWarning: boolean;
  duplicate: boolean;
  notesCount: number;
  workspaceName?: string;
}

function toDto(e: ShortlistEntry, extra: DtoExtras): ShortlistEntryDto {
  const out: ShortlistEntryDto = {
    id: e.id,
    workspaceId: e.workspaceId,
    companyId: extra.companyId,
    status: e.status,
    nextActionAt: e.nextActionAt ? e.nextActionAt.toISOString() : null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    sanctionsWarning: extra.sanctionsWarning,
    duplicate: extra.duplicate,
    notesCount: extra.notesCount,
  };
  if (extra.workspaceName !== undefined) out.workspaceName = extra.workspaceName;
  return out;
}

/** EV-08, emitted in its own systemDb transaction after the status write commits — the same
 * pattern M30 uses for its own M02 calls (ScopedDb does not expose the raw Tx that emit() needs). */
async function emitStatusChanged(payload: Omit<PipelineStatusChangedPayload, 'v'>): Promise<void> {
  try {
    await systemDb('m33: pipeline status changed')
      .transaction()
      .execute((tx: Tx) => emit(tx, EV_PIPELINE_STATUS_CHANGED, { v: 1, ...payload }));
  } catch (err) {
    log.error({ err, payload }, 'm33: failed to emit pipeline.status_changed');
  }
}

/** Resolves company ids through M10 (redirect + sanctions), building the DTOs for a batch of
 * entries in one pass, including the workspace-scoped "duplicate" hint. */
async function toDtos(ctx: ActorContext, rows: ShortlistEntry[], workspaceNames?: Map<string, string>): Promise<ShortlistEntryDto[]> {
  if (rows.length === 0) return [];
  const companyIds = [...new Set(rows.map((r) => r.companyId))];
  const [decisions, counts] = await Promise.all([
    byIds(ctx, 'profile', companyIds),
    notesCountByEntry(scoped(ctx), rows.map((r) => r.id)),
  ]);

  const resolvedByEntry = new Map<string, string>();
  for (const r of rows) {
    const entry = decisions.get(r.companyId as Id<'company'>);
    resolvedByEntry.set(r.id, entry?.doc?.company_id ?? r.companyId);
  }
  const groupCounts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.workspaceId}|${resolvedByEntry.get(r.id)}`;
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }

  return rows.map((r) => {
    const entry = decisions.get(r.companyId as Id<'company'>);
    const decision: PolicyDecision | undefined = entry?.decision;
    const resolved = resolvedByEntry.get(r.id)!;
    const key = `${r.workspaceId}|${resolved}`;
    return toDto(r, {
      companyId: resolved,
      sanctionsWarning: decision?.visibility === 'visible_with_warning',
      duplicate: (groupCounts.get(key) ?? 0) > 1,
      notesCount: counts.get(r.id) ?? 0,
      workspaceName: workspaceNames?.get(r.workspaceId),
    });
  });
}

// ---- add to shortlist (single or bulk) ---------------------------------------------------------

/** POST /api/workspaces/:ws/shortlist (IF-33a). */
export async function addToShortlist(ctx: ActorContext, rawWorkspaceId: unknown, rawBody: unknown): Promise<AddToShortlistResponseDto> {
  const { accountId } = requireMember(ctx);
  const workspaceId = parseWorkspaceIdParam(rawWorkspaceId);
  await getWorkspace(ctx, workspaceId); // NOT_FOUND unless this account's live workspace

  const b = objectBody(rawBody);
  const requestedIds = parseCompanyIds(b.companyIds);

  return withSpan(
    'm33.addToShortlist',
    async () => {
      const decisions = await byIds(ctx, 'profile', requestedIds);
      const sdb = scoped(ctx);
      const now = new Date();

      const added: ShortlistEntryDto[] = [];
      const alreadyPresent: string[] = [];
      const denied: AddToShortlistDeniedDto[] = [];
      const seenResolved = new Set<string>();

      for (const requestedId of requestedIds) {
        const entry = decisions.get(requestedId as Id<'company'>);
        const decision = entry?.decision;
        if (!entry || !entry.doc || !decision || decision.visibility === 'hidden') {
          denied.push({ companyId: requestedId, reason: decision && decision.reasons.length > 0 ? decision.reasons[0]! : 'NOT_FOUND' });
          continue;
        }
        const resolvedId = entry.doc.company_id;
        if (seenResolved.has(resolvedId)) {
          alreadyPresent.push(requestedId);
          continue;
        }
        seenResolved.add(resolvedId);
        const row = await insertEntryIfAbsent(sdb, accountId, workspaceId, resolvedId, now);
        if (!row) {
          alreadyPresent.push(requestedId);
          continue;
        }
        added.push(
          toDto(row, {
            companyId: resolvedId,
            sanctionsWarning: decision.visibility === 'visible_with_warning',
            duplicate: false,
            notesCount: 0,
          }),
        );
      }

      return { added, alreadyPresent, denied };
    },
    { workspaceId, n: requestedIds.length },
  );
}

// ---- status ---------------------------------------------------------------------------------

/** PATCH /api/shortlist/:id (IF-33a). */
export async function updateShortlistStatus(ctx: ActorContext, rawId: unknown, rawBody: unknown): Promise<ShortlistEntryDto> {
  requireMember(ctx);
  const id = parseEntryIdParam(rawId);
  const patch = parseStatusPatch(rawBody);
  const now = new Date();

  const result = await scoped(ctx).transaction(async (db) => {
    const current = await findEntryById(db, id, true);
    if (!current) throw entryNotFound();

    const set: { status?: ShortlistStatus; next_action_at?: Date | null } = {};
    let historyNeeded = false;
    // LLD Rules: "Setting the same status is a no-op."
    if (patch.status !== undefined && patch.status !== current.status) {
      set.status = patch.status;
      historyNeeded = true;
    }
    if (patch.nextActionAt !== undefined) {
      set.next_action_at = patch.nextActionAt === null ? null : new Date(patch.nextActionAt);
    }

    let entry = current;
    if (Object.keys(set).length > 0) {
      const updated = await updateEntry(db, id, set, now);
      if (!updated) throw entryNotFound();
      entry = updated;
    }
    if (historyNeeded) {
      await insertStatusHistory(db, {
        entryId: id,
        accountId: entry.accountId,
        workspaceId: entry.workspaceId,
        from: current.status,
        to: entry.status,
        source: 'user',
        at: now,
      });
    }
    return { entry, historyNeeded, from: current.status };
  });

  if (result.historyNeeded) {
    await emitStatusChanged({
      entryId: id,
      accountId: result.entry.accountId,
      workspaceId: result.entry.workspaceId,
      companyId: result.entry.companyId,
      fromStatus: result.from,
      toStatus: result.entry.status,
      source: 'user',
      at: now.toISOString(),
    });
  }

  const [dto] = await toDtos(ctx, [result.entry]);
  return dto!;
}

/**
 * EV-09 `draft.left_product` handler (LLD M33 Rules): auto-sets `to_contact` → `contacted`,
 * source `auto_draft`. Runs on the event handler's own transaction; see events.ts.
 */
export async function handleDraftLeftProduct(tx: Tx, entryId: string, now: Date = new Date()): Promise<void> {
  const outcome = await applyAutoContactedIfToContact(tx, entryId, now);
  if (!outcome) return; // already past to_contact, or the entry does not exist: no-op
  await emit(tx, EV_PIPELINE_STATUS_CHANGED, {
    v: 1,
    entryId,
    accountId: outcome.entry.accountId,
    workspaceId: outcome.entry.workspaceId,
    companyId: outcome.entry.companyId,
    fromStatus: outcome.from,
    toStatus: outcome.entry.status,
    source: 'auto_draft',
    at: now.toISOString(),
  });
}

// ---- notes ------------------------------------------------------------------------------------

/** POST /api/shortlist/:id/notes {body} (IF-33a). */
export async function addNote(ctx: ActorContext, rawEntryId: unknown, rawBody: unknown): Promise<NoteDto> {
  const { accountId } = requireMember(ctx);
  const id = parseEntryIdParam(rawEntryId);
  const body = parseNoteBody(objectBody(rawBody).body);
  const now = new Date();
  const sdb = scoped(ctx);

  const entry = await findEntryById(sdb, id);
  if (!entry) throw entryNotFound();
  const note = await insertNote(sdb, { accountId, workspaceId: entry.workspaceId, entryId: id, body }, now);
  return toNoteDto(note);
}

/** PATCH /api/shortlist/:id/notes {noteId, body} (IF-33a). */
export async function editNote(ctx: ActorContext, rawEntryId: unknown, rawBody: unknown): Promise<NoteDto> {
  requireMember(ctx);
  const id = parseEntryIdParam(rawEntryId);
  const b = objectBody(rawBody);
  const noteId = parseNoteId(b.noteId);
  const body = parseNoteBody(b.body);
  const now = new Date();
  const sdb = scoped(ctx);

  const entry = await findEntryById(sdb, id);
  if (!entry) throw entryNotFound();
  const note = await updateNote(sdb, noteId, id, body, now);
  if (!note) throw noteNotFound();
  return toNoteDto(note);
}

/** DELETE /api/shortlist/:id/notes {noteId} (IF-33a). */
export async function removeNote(ctx: ActorContext, rawEntryId: unknown, rawBody: unknown): Promise<void> {
  requireMember(ctx);
  const id = parseEntryIdParam(rawEntryId);
  const noteId = parseNoteId(objectBody(rawBody).noteId);
  const sdb = scoped(ctx);

  const entry = await findEntryById(sdb, id);
  if (!entry) throw entryNotFound();
  const ok = await deleteNote(sdb, noteId, id);
  if (!ok) throw noteNotFound();
}

// ---- reads --------------------------------------------------------------------------------------

/** GET /api/workspaces/:ws/shortlist?status (IF-33a). */
export async function listWorkspaceShortlist(ctx: ActorContext, rawWorkspaceId: unknown, rawStatus: unknown): Promise<ShortlistListResponseDto> {
  requireMember(ctx);
  const workspaceId = parseWorkspaceIdParam(rawWorkspaceId);
  await getWorkspace(ctx, workspaceId);
  const status = parseStatusQuery(rawStatus);
  const rows = await listEntries(scoped(ctx), { workspaceId, status });
  return { entries: await toDtos(ctx, rows) };
}

/** GET /api/my-buyers?status&workspaceId (IF-33a): the cross-workspace "My buyers" view. */
export async function myBuyers(ctx: ActorContext, rawStatus: unknown, rawWorkspaceId: unknown): Promise<MyBuyersResponseDto> {
  requireMember(ctx);
  const status = parseStatusQuery(rawStatus);
  const workspaceId = parseWorkspaceIdQuery(rawWorkspaceId);
  if (workspaceId) await getWorkspace(ctx, workspaceId);

  const rows = await listEntries(scoped(ctx), { workspaceId, status });
  const wsIds = [...new Set(rows.map((r) => r.workspaceId))];
  const names = new Map<string, string>();
  await Promise.all(
    wsIds.map(async (wid) => {
      try {
        names.set(wid, (await getWorkspace(ctx, wid)).name);
      } catch (err) {
        log.warn({ err, workspaceId: wid }, 'm33: could not resolve workspace name for My buyers');
      }
    }),
  );
  return { entries: await toDtos(ctx, rows, names) };
}
