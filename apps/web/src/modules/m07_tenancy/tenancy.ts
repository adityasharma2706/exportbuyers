/**
 * M07 — business profile, onboarding and product workspaces.
 *
 * IF-07a getWorkspace, listWorkspaces, setHsCode, setCountries (+ create/rename/delete)
 * IF-07b getBusinessProfile
 *
 * Tenancy model: Account → Members (M05; one member per account in the MVP) → Workspaces.
 * Every request path goes through scoped(ctx), so another account's rows read as NOT_FOUND.
 */
import { AppError, isUuid, log, newId, scoped, type ActorContext, type Id, type ScopedDb } from '../m01_platform/index.js';
import { requestMetaOf, requireMember, takeAnonStatePending, updateAnonState } from '../m05_identity/index.js';
import { assertCoreConsent } from '../m06_consent/index.js';
import { tenancyConfig } from './config.js';
import {
  WORKSPACE_NAME_UNIQUE,
  countLiveWorkspaces,
  findLiveWorkspace,
  findProfile,
  insertProfile,
  insertWorkspace,
  isUniqueViolation,
  listLiveWorkspaces,
  lockAccountWorkspaces,
  updateLiveWorkspace,
  updateProfile,
  type BusinessProfileRow,
  type WorkspaceRow,
} from './repo.js';
import type {
  AnonCarryOver,
  BusinessProfile,
  HsSelection,
  OnboardingInput,
  OnboardingResult,
  ProfilePatch,
  Workspace,
  WorkspaceCreateInput,
  WorkspacePatch,
} from './types.js';
import { defaultWorkspaceName, parseAnonCarryOver, parseCountries, parseHsSelection, parseWorkspaceName } from './validate.js';

// ---- helpers --------------------------------------------------------------------------------

function db(ctx: ActorContext): ScopedDb {
  requireMember(ctx);
  return scoped(ctx);
}

function workspaceNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Workspace not found');
}

function assertWorkspaceId(id: string): void {
  // Malformed ids are reported like missing ones (never leak whether a row exists).
  if (!isUuid(id)) throw workspaceNotFound();
}

function nameTaken(name: string, cause: unknown): AppError {
  return new AppError('CONFLICT', 'A workspace with this name already exists', { field: 'name', name }, { cause });
}

// ---- IF-07b business profile ------------------------------------------------------------------

/** IF-07b. NOT_FOUND until onboarding has created the profile. */
export async function getBusinessProfile(ctx: ActorContext): Promise<BusinessProfile> {
  const p = await findProfile(db(ctx));
  if (!p) throw new AppError('NOT_FOUND', 'Business profile not found; complete onboarding first', { onboardingRequired: true });
  return p;
}

/** Returns the profile or null (used by UI routing to decide whether onboarding is needed). */
export async function findBusinessProfile(ctx: ActorContext): Promise<BusinessProfile | null> {
  return (await findProfile(db(ctx))) ?? null;
}

/** PATCH /api/profile. Every field is editable. Changing the IEC clears its verification. */
export async function updateBusinessProfile(ctx: ActorContext, patch: ProfilePatch): Promise<BusinessProfile> {
  const sdb = db(ctx);
  return sdb.transaction(async (tx) => {
    const current = await findProfile(tx);
    if (!current) throw new AppError('NOT_FOUND', 'Business profile not found; complete onboarding first', { onboardingRequired: true });
    const set: Partial<Omit<BusinessProfileRow, 'account_id'>> = { updated_at: new Date() };
    if (patch.businessName !== undefined) set.business_name = patch.businessName;
    if (patch.city !== undefined) set.city = patch.city;
    if (patch.state !== undefined) set.state = patch.state;
    if (patch.whatTheyMake !== undefined) set.what_they_make = patch.whatTheyMake;
    if (patch.exportExperience !== undefined) set.export_experience = patch.exportExperience;
    if (patch.iec !== undefined && patch.iec !== current.iec) {
      set.iec = patch.iec;
      // A different IEC has not been verified (REQ-003 groundwork; M49 sets iec_verified_at).
      set.iec_verified_at = null;
    }
    if (patch.targetMarkets !== undefined) set.target_markets = patch.targetMarkets;
    if (patch.senderName !== undefined) set.sender_name = patch.senderName;
    if (patch.senderEmail !== undefined) set.sender_email = patch.senderEmail;
    if (patch.website !== undefined) set.website = patch.website;
    const updated = await updateProfile(tx, set);
    if (!updated) throw new AppError('NOT_FOUND', 'Business profile not found');
    return updated;
  });
}

// ---- onboarding -------------------------------------------------------------------------------

/**
 * Consumes M05's anon_state_pending for this signed-in session (HLD assumption 7). The
 * state is cleared by the read; anything malformed is dropped rather than failing onboarding.
 */
async function consumeCarryOver(ctx: ActorContext): Promise<AnonCarryOver> {
  const sessionId = requestMetaOf(ctx)?.sessionId;
  if (!sessionId) return { hs: null, countries: [] };
  try {
    return parseAnonCarryOver(await takeAnonStatePending(sessionId));
  } catch (err) {
    log.warn({ err, correlationId: ctx.correlationId }, 'could not read anonymous carry-over; continuing without it');
    return { hs: null, countries: [] };
  }
}

/**
 * POST /api/onboarding. Blocked until core_service consent is granted (M06). Creates the
 * business profile and the first workspace, named after `whatTheyMake` (≤ 60 chars) and
 * seeded with the anonymous HS code and countries. Repeating onboarding does not create a
 * second profile: the existing first workspace is returned with `created: false`.
 */
export async function completeOnboarding(ctx: ActorContext, input: OnboardingInput): Promise<OnboardingResult> {
  const { accountId } = requireMember(ctx);
  await assertCoreConsent(ctx);
  const sdb = scoped(ctx);

  const existing = await findProfile(sdb);
  if (existing) {
    const first = (await listLiveWorkspaces(sdb))[0];
    if (first) return { workspaceId: first.id, created: false };
  }

  const carry = await consumeCarryOver(ctx);
  const max = tenancyConfig().maxCountriesPerWorkspace;
  const countries = (carry.countries.length > 0 ? carry.countries : input.targetMarkets).slice(0, max);
  const now = new Date();

  try {
    return await sdb.transaction(async (tx) => {
      await lockAccountWorkspaces(tx, accountId);
      const inserted = await insertProfile(tx, {
        business_name: input.businessName,
        city: input.city,
        state: input.state,
        what_they_make: input.whatTheyMake,
        export_experience: input.exportExperience,
        iec: input.iec,
        iec_verified_at: null,
        target_markets: input.targetMarkets,
        sender_name: null,
        sender_email: null,
        website: null,
        created_at: now,
        updated_at: now,
      });
      if (!inserted) {
        // A concurrent onboarding won; return its workspace if it made one.
        const first = (await listLiveWorkspaces(tx))[0];
        if (first) return { workspaceId: first.id, created: false };
      }
      const name = await uniqueName(tx, defaultWorkspaceName(input.whatTheyMake));
      const ws = await createWorkspaceRow(tx, { name, hs: carry.hs, countries }, now);
      return { workspaceId: ws.id, created: true };
    });
  } catch (e) {
    if (isUniqueViolation(e, WORKSPACE_NAME_UNIQUE)) throw nameTaken(defaultWorkspaceName(input.whatTheyMake), e);
    throw e;
  }
}

/** Appends " (2)", " (3)"… when the default name is already used by a live workspace. */
async function uniqueName(tx: ScopedDb, base: string): Promise<string> {
  const taken = new Set((await listLiveWorkspaces(tx)).map((w) => w.name));
  if (!taken.has(base)) return base;
  const maxLen = tenancyConfig().workspaceNameMaxLength;
  for (let i = 2; i < 1000; i += 1) {
    const suffix = ` (${i})`;
    const stem = Array.from(base).slice(0, maxLen - suffix.length).join('').trimEnd();
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new AppError('CONFLICT', 'Could not find a free workspace name', { field: 'name' });
}

// ---- anonymous selections ---------------------------------------------------------------------

/**
 * Stores anonymous work ({hsCode, hsVersion, countries[]}) on the anonymous session so it is
 * carried into the first workspace at sign-in. No-op for signed-in or unpersisted sessions.
 */
export async function rememberAnonymousSelection(
  ctx: ActorContext,
  sel: { hs?: HsSelection | null; countries?: string[] },
): Promise<void> {
  if (ctx.kind !== 'anonymous') return;
  const meta = requestMetaOf(ctx);
  if (!meta?.sessionId || !meta.session?.anon) return;
  const state: Record<string, unknown> = { ...meta.session.anon_state };
  if (sel.hs !== undefined) {
    if (sel.hs === null) {
      delete state.hsCode;
      delete state.hsVersion;
      delete state.hsLevel;
    } else {
      const hs = parseHsSelection(sel.hs);
      state.hsCode = hs.code;
      state.hsVersion = hs.version;
      state.hsLevel = hs.level;
    }
  }
  if (sel.countries !== undefined) {
    state.countries = parseCountries(sel.countries, 'countries', tenancyConfig().maxCountriesPerWorkspace);
  }
  await updateAnonState(meta.sessionId, state);
  meta.session.anon_state = state;
}

// ---- IF-07a workspaces ------------------------------------------------------------------------

async function createWorkspaceRow(
  tx: ScopedDb,
  input: { name: string; hs: HsSelection | null; countries: string[] },
  now: Date,
): Promise<Workspace> {
  const cfg = tenancyConfig();
  const live = await countLiveWorkspaces(tx);
  if (live >= cfg.maxWorkspacesPerAccount) {
    throw new AppError('CONFLICT', `An account can have at most ${cfg.maxWorkspacesPerAccount} workspaces`, {
      subCode: 'WORKSPACE_LIMIT',
      limit: cfg.maxWorkspacesPerAccount,
    });
  }
  if (input.countries.length > cfg.maxCountriesPerWorkspace) {
    throw new AppError('VALIDATION', `At most ${cfg.maxCountriesPerWorkspace} countries are allowed`, {
      field: 'countries',
      max: cfg.maxCountriesPerWorkspace,
    });
  }
  const row: Omit<WorkspaceRow, 'account_id'> = {
    id: newId<'workspace'>(),
    name: input.name,
    hs_code: input.hs?.code ?? null,
    hs_level: input.hs?.level ?? null,
    hs_version: input.hs?.version ?? null,
    hs_needs_reconfirm: false,
    countries: input.countries,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  return insertWorkspace(tx, row);
}

/** POST /api/workspaces. Needs a completed onboarding (a business profile). */
export async function createWorkspace(ctx: ActorContext, input: WorkspaceCreateInput): Promise<Workspace> {
  const { accountId } = requireMember(ctx);
  const sdb = scoped(ctx);
  try {
    return await sdb.transaction(async (tx) => {
      if (!(await findProfile(tx))) {
        throw new AppError('CONFLICT', 'Complete onboarding before adding products', { onboardingRequired: true });
      }
      await lockAccountWorkspaces(tx, accountId);
      return createWorkspaceRow(tx, { name: input.name, hs: input.hs ?? null, countries: input.countries ?? [] }, new Date());
    });
  } catch (e) {
    if (isUniqueViolation(e, WORKSPACE_NAME_UNIQUE)) throw nameTaken(input.name, e);
    throw e;
  }
}

/** IF-07a. Live workspaces of the actor's account, oldest first. */
export async function listWorkspaces(ctx: ActorContext): Promise<Workspace[]> {
  return listLiveWorkspaces(db(ctx));
}

/** IF-07a. NOT_FOUND for deleted workspaces and for other accounts' workspaces. */
export async function getWorkspace(ctx: ActorContext, id: Id<'workspace'> | string): Promise<Workspace> {
  assertWorkspaceId(id);
  const w = await findLiveWorkspace(db(ctx), id);
  if (!w) throw workspaceNotFound();
  return w;
}

async function updateOrNotFound(
  ctx: ActorContext,
  id: string,
  set: Partial<Omit<WorkspaceRow, 'account_id' | 'id' | 'created_at'>>,
  nameForConflict?: string,
): Promise<Workspace> {
  assertWorkspaceId(id);
  try {
    const w = await updateLiveWorkspace(db(ctx), id, { ...set, updated_at: new Date() });
    if (!w) throw workspaceNotFound();
    return w;
  } catch (e) {
    if (isUniqueViolation(e, WORKSPACE_NAME_UNIQUE)) throw nameTaken(nameForConflict ?? '', e);
    throw e;
  }
}

/** PATCH /api/workspaces/:id — rename and/or change countries. */
export async function updateWorkspace(ctx: ActorContext, id: Id<'workspace'> | string, patch: WorkspacePatch): Promise<Workspace> {
  const set: Partial<Omit<WorkspaceRow, 'account_id' | 'id' | 'created_at'>> = {};
  if (patch.name !== undefined) set.name = parseWorkspaceName(patch.name);
  if (patch.countries !== undefined) {
    set.countries = parseCountries(patch.countries, 'countries', tenancyConfig().maxCountriesPerWorkspace);
  }
  if (Object.keys(set).length === 0) throw new AppError('VALIDATION', 'Nothing to update');
  return updateOrNotFound(ctx, id, set, set.name);
}

export async function renameWorkspace(ctx: ActorContext, id: Id<'workspace'> | string, name: string): Promise<Workspace> {
  return updateWorkspace(ctx, id, { name });
}

/**
 * IF-07a. Sets the product's HS code (from M11 suggest/confirm or M40 re-confirmation) and
 * clears the re-confirmation flag.
 */
export async function setHsCode(
  ctx: ActorContext,
  id: Id<'workspace'> | string,
  hs: { code: string; level?: string; version: string },
): Promise<void> {
  const sel = parseHsSelection(hs);
  await updateOrNotFound(ctx, id, {
    hs_code: sel.code,
    hs_level: sel.level,
    hs_version: sel.version,
    hs_needs_reconfirm: false,
  });
}

/** IF-07a. Replaces the chosen markets (ISO alpha-2, at most 20 [tunable]). */
export async function setCountries(ctx: ActorContext, id: Id<'workspace'> | string, countries: string[]): Promise<void> {
  const list = parseCountries(countries, 'countries', tenancyConfig().maxCountriesPerWorkspace);
  await updateOrNotFound(ctx, id, { countries: list });
}

/**
 * DELETE /api/workspaces/:id — soft delete. Shortlists and searches stay but are hidden
 * (later modules filter on live workspaces); the row is hard-purged after 30 days or by M38.
 */
export async function deleteWorkspace(ctx: ActorContext, id: Id<'workspace'> | string): Promise<void> {
  assertWorkspaceId(id);
  const now = new Date();
  const w = await updateLiveWorkspace(db(ctx), id, { deleted_at: now, updated_at: now });
  if (!w) throw workspaceNotFound();
}

/**
 * Returns a context narrowed to one live workspace of the actor's account, for
 * workspace-scoped tables in later modules (M01 scoped() then filters by workspace_id).
 */
export async function withWorkspace(ctx: ActorContext, id: Id<'workspace'> | string): Promise<ActorContext> {
  const w = await getWorkspace(ctx, id);
  return { ...ctx, workspaceId: w.id };
}
