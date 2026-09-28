/**
 * M40 — read API for the re-confirm banner and the "pick a code" endpoint (IF-40a).
 *
 *   listReconfirmations(ctx)              flagged workspaces of the actor's account, with
 *                                          freshly computed correlation candidates
 *   reconfirmWorkspace(ctx, id, body)      POST /api/workspaces/:id/hs/reconfirm {code}
 */
import { AppError, isAppError, type ActorContext } from '../m01_platform/index.js';
import { getWorkspace, listWorkspaces, setHsCode, type Workspace } from '../m07_tenancy/index.js';
import { correlate, currentVersion, levelForCode, lookup, normalizeCode, type HsCorrelationResult, type HsLevel } from '../m12_hs/index.js';
import type { ReconfirmCandidateDto, ReconfirmItemDto } from './types.js';

function candidateDtos(rows: HsCorrelationResult[]): ReconfirmCandidateDto[] {
  return rows.map((r) => ({ code: r.code, relation: r.relation }));
}

/**
 * Live candidates for one flagged workspace: correlate() against the current version for the
 * code's level. Returns null when there is nothing pending after all (the level's nomenclature
 * has no current version yet, or it turns out to already match `hs.version`).
 */
async function candidatesFor(ws: Workspace): Promise<{ newVersion: string; candidates: ReconfirmCandidateDto[] } | null> {
  if (!ws.hs) return null;
  let newVersion: string;
  try {
    newVersion = await currentVersion(ws.hs.level);
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') return null;
    throw e;
  }
  if (newVersion === ws.hs.version) return null;
  try {
    const rows = await correlate(ws.hs.version, ws.hs.code, newVersion);
    return { newVersion, candidates: candidateDtos(rows) };
  } catch (e) {
    // No correlation table loaded between the two versions: an empty candidate list, not a failure.
    if (isAppError(e) && e.code === 'NOT_FOUND') return { newVersion, candidates: [] };
    throw e;
  }
}

/** GET /api/hs/reconfirm — flagged workspaces of the signed-in account (IF-40a). */
export async function listReconfirmations(ctx: ActorContext): Promise<ReconfirmItemDto[]> {
  const workspaces = (await listWorkspaces(ctx)).filter((w) => w.hsNeedsReconfirm && w.hs !== null);
  const out: ReconfirmItemDto[] = [];
  for (const ws of workspaces) {
    if (!ws.hs) continue;
    const c = await candidatesFor(ws);
    if (!c) continue;
    out.push({
      workspaceId: ws.id,
      workspaceName: ws.name,
      oldCode: ws.hs.code,
      oldVersion: ws.hs.version,
      newVersion: c.newVersion,
      level: ws.hs.level,
      candidates: c.candidates,
    });
  }
  return out;
}

function parseReconfirmCode(body: unknown): string {
  const o = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const raw = o?.code;
  if (typeof raw !== 'string') throw new AppError('VALIDATION', 'code is required', { field: 'code' });
  try {
    return normalizeCode(raw);
  } catch (e) {
    if (isAppError(e)) throw new AppError('VALIDATION', 'An HS code has 2, 4, 6 or 8 digits', { field: 'code' });
    throw e;
  }
}

/**
 * POST /api/workspaces/:id/hs/reconfirm {code} — resolves the pending re-confirmation: the code
 * is looked up in the current nomenclature version for its own digit length, then saved through
 * M07's `setHsCode` (IF-07a), which clears `hs_needs_reconfirm`. CONFLICT when the workspace has
 * no pending re-confirmation (use M13's POST /api/workspaces/:id/hs to change an already-current
 * code instead); NOT_FOUND when `code` does not exist in the current nomenclature.
 */
export async function reconfirmWorkspace(ctx: ActorContext, workspaceId: string, body: unknown): Promise<Workspace> {
  const ws = await getWorkspace(ctx, workspaceId);
  if (!ws.hsNeedsReconfirm) {
    throw new AppError('CONFLICT', 'This product has no pending HS code re-confirmation', { subCode: 'NOT_PENDING' });
  }
  const code = parseReconfirmCode(body);
  const level: HsLevel = levelForCode(code);
  const version = await currentVersion(level);
  const node = await lookup(version, code);
  if (!node) throw new AppError('NOT_FOUND', `HS code ${code} was not found in ${version}`, { code, version });
  await setHsCode(ctx, workspaceId, { code: node.code, level: node.level, version: node.version });
  return getWorkspace(ctx, workspaceId);
}
