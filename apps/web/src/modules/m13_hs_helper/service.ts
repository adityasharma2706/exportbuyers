/**
 * M13 — hierarchy browsing, direct code entry and saving the chosen code. REQ-006, REQ-007, REQ-004.
 *
 *   browseHs(parent|null, version?)      chapter → heading → subheading → ITC-HS line
 *   codeDetail(code, version?)           direct entry of a 2/4/6/8-digit code
 *   saveWorkspaceHs(ctx, id, body)       signed-in: writes {code, level, version} to the workspace (M07)
 *   saveAnonymousHs(ctx, body)           anonymous: stored in session.anon_state (carried over at sign-in)
 *
 * Browsing defaults to the current ITC-HS version: M12 serves the 2/4/6-digit levels of an
 * ITC-HS version from the HS version of the same year, so one version walks the whole tree.
 * Every node carries its own nomenclature version, and that is what gets saved.
 */
import { AppError, isAppError, type ActorContext } from '../m01_platform/index.js';
import { requestMetaOf, requireMember } from '../m05_identity/index.js';
import { rememberAnonymousSelection, setHsCode } from '../m07_tenancy/index.js';
import { VERSION_RE, browse, currentVersion, levelForCode, lookup, normalizeCode, type HsLevel, type HsNode } from '../m12_hs/index.js';
import { HS_DISCLAIMER_KEY, type HsBrowseDto, type HsCodeDetailDto, type HsNodeDto, type HsSavedSelectionDto } from './types.js';

export function nodeDto(n: HsNode): HsNodeDto {
  const national = n.level === 'national8';
  return {
    code: n.code,
    level: n.level,
    version: n.version,
    parentCode: n.parentCode,
    description: n.description,
    descriptionSimple: n.descriptionEnSimple,
    exportPolicy: national ? n.exportPolicy : null,
    policyConditions: national ? n.policyConditions : null,
    policyUrl: national ? n.policySourceUrl : null,
    hasChildren: !national,
  };
}

export function parseVersion(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AppError('VALIDATION', 'version must be a string', { field: 'version' });
  const s = v.trim().toUpperCase();
  if (!VERSION_RE.test(s)) throw new AppError('VALIDATION', 'version must look like HS2022 or ITCHS2022', { field: 'version' });
  return s;
}

function parseCode(v: unknown, field = 'code'): string {
  if (typeof v !== 'string') throw new AppError('VALIDATION', `${field} must be a string of digits`, { field });
  try {
    return normalizeCode(v);
  } catch (e) {
    if (isAppError(e)) throw new AppError('VALIDATION', 'An HS code has 2, 4, 6 or 8 digits', { field });
    throw e;
  }
}

/** Current ITC-HS version when loaded, otherwise the current HS version. */
export async function defaultBrowseVersion(): Promise<string> {
  try {
    return await currentVersion('national8');
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') return currentVersion('subheading');
    throw e;
  }
}

/** Version used to resolve a directly entered code when the caller gave none. */
async function defaultVersionFor(level: HsLevel): Promise<string> {
  return level === 'national8' ? currentVersion('national8') : defaultBrowseVersion();
}

async function ancestors(version: string, node: HsNode): Promise<HsNodeDto[]> {
  const path: HsNodeDto[] = [];
  let parent = node.parentCode;
  for (let depth = 0; parent && depth < 4; depth++) {
    const p = await lookup(version, parent);
    if (!p) break;
    path.unshift(nodeDto(p));
    parent = p.parentCode;
  }
  return path;
}

async function detail(version: string, node: HsNode): Promise<HsCodeDetailDto> {
  return {
    ...nodeDto(node),
    path: await ancestors(version, node),
    policyNote: node.level === 'national8' ? null : 'pick_8_digit',
    disclaimerKey: HS_DISCLAIMER_KEY,
  };
}

/** GET /api/hs/code/:code — NOT_FOUND when the code does not exist in the version. */
export async function codeDetail(rawCode: unknown, rawVersion?: unknown): Promise<HsCodeDetailDto> {
  const code = parseCode(rawCode);
  const version = parseVersion(rawVersion) ?? (await defaultVersionFor(levelForCode(code)));
  const node = await lookup(version, code);
  if (!node) throw new AppError('NOT_FOUND', `HS code ${code} was not found in ${version}`, { code, version });
  return detail(version, node);
}

/** GET /api/hs/browse?parent=&version= — children of `parent`, or the chapters when it is empty. */
export async function browseHs(rawParent?: unknown, rawVersion?: unknown): Promise<HsBrowseDto> {
  const version = parseVersion(rawVersion) ?? (await defaultBrowseVersion());
  const parentCode = rawParent === undefined || rawParent === null || rawParent === '' ? null : parseCode(rawParent, 'parent');
  let parent: HsCodeDetailDto | null = null;
  if (parentCode !== null) {
    const node = await lookup(version, parentCode);
    if (!node) throw new AppError('NOT_FOUND', `HS code ${parentCode} was not found in ${version}`, { code: parentCode, version });
    parent = await detail(version, node);
  }
  const nodes = (await browse(version, parentCode)).map(nodeDto);
  return { version, parent, nodes };
}

/**
 * Validates {code, version} against the nomenclature. The saved version is the version the
 * node actually belongs to (a 6-digit code picked under ITCHS2022 is an HS2022 subheading).
 */
export async function resolveSelection(body: unknown): Promise<{ code: string; level: HsLevel; version: string }> {
  const o = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!o) throw new AppError('VALIDATION', 'Body must be an object {code, version}');
  const code = parseCode(o.code);
  const version = parseVersion(o.version);
  if (!version) throw new AppError('VALIDATION', 'version is required', { field: 'version' });
  const node = await lookup(version, code);
  if (!node) throw new AppError('NOT_FOUND', `HS code ${code} was not found in ${version}`, { code, version });
  return { code: node.code, level: node.level, version: node.version };
}

/** POST /api/workspaces/:id/hs (signed in). */
export async function saveWorkspaceHs(ctx: ActorContext, workspaceId: string, body: unknown): Promise<HsSavedSelectionDto> {
  requireMember(ctx);
  const hs = await resolveSelection(body);
  await setHsCode(ctx, workspaceId, hs);
  return { hs, persisted: true };
}

/** POST /api/anon/hs (anonymous; stored in session.anon_state and carried over at sign-up). */
export async function saveAnonymousHs(ctx: ActorContext, body: unknown): Promise<HsSavedSelectionDto> {
  if (ctx.kind !== 'anonymous') {
    throw new AppError('VALIDATION', 'Signed-in users save the code to a workspace: POST /api/workspaces/:id/hs', {
      subCode: 'USE_WORKSPACE',
    });
  }
  const hs = await resolveSelection(body);
  const meta = requestMetaOf(ctx);
  const persisted = Boolean(meta?.sessionId && meta.session?.anon);
  await rememberAnonymousSelection(ctx, { hs });
  return { hs, persisted };
}
