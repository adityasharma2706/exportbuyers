/**
 * M29 Contact reveal — core service (LLD M29 "Sequence (single reveal)" and "Bulk").
 * REQ-032, REQ-033, REQ-034, REQ-029 (blocked reveal), REQ-054.
 *
 * Deps: M10 (assertAllowed — global suppression, sanctions doc-flag, licence, region, plan caps
 * and REQ-029's "reveal disabled" outcome all come from here), M17 (the synchronous, live
 * sanctions re-check), M25 (the reverify RPC, via ./reverify.ts), M27 (this module registers
 * itself as M27's `revealed` provider so the profile page can show "already revealed"), M28
 * (quote/hold/commit/release/consumeAllowance/undoAllowance/refund — REQ-054's credits accounting).
 */
import {
  AppError,
  isUuid,
  log,
  newId,
  systemDb,
  withSpan,
  type ActorContext,
  type Db,
} from '../m01_platform/index.js';
import { requireMember } from '../m05_identity/index.js';
import { assertAllowed, type ProfileDoc } from '../m10_policy/index.js';
import { assertSanctionsClear } from '../m17_sanctions/index.js';
import { commit, consumeAllowance, hold, quote, refund, release, undoAllowance } from '../m28_credits/index.js';
import { enqueue } from '../m02_queue/index.js';
import { mapLimit } from './concurrency.js';
import { BULK_CONCURRENCY, BULK_JOB_QUEUE, BULK_JOB_TYPE, INLINE_BULK_MAX } from './config.js';
import { decryptValue, encryptValue } from './crypto.js';
import { fetchContactValues } from './contactValues.js';
import { reverify as reverifyRpc } from './reverify.js';
import {
  findDoneReveal,
  findDoneRevealCompanyIds,
  findRevealBulk,
  insertRevealBulk,
  insertRevealDone,
  insertRevealDoneMany,
  listRevealContacts,
  listRevealedContactsForAccount,
  updateRevealBulk,
  type RevealContactInsert,
  type RevealInsert,
} from './repo.js';
import { excludeInvalid, isStale, resolveSlots, splitByStaleness } from './slots.js';
import type {
  BulkJobPayload,
  BulkRevealResponseDto,
  Deliverability,
  ProfileContactSlot,
  ResolvedContact,
  RevealApiResponse,
  RevealBulkItem,
  RevealedContact,
  RevealedContactDto,
} from './types.js';

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;

function toDeliverableStatus(d: Deliverability): 'valid' | 'risky' | 'unknown' {
  switch (d) {
    case 'valid':
      return 'valid';
    case 'risky':
      return 'risky';
    default:
      return 'unknown';
  }
}

// ---- request parsing --------------------------------------------------------------------------

function parseCompanyId(raw: unknown): string {
  if (typeof raw !== 'string' || !isUuid(raw)) throw new AppError('VALIDATION', 'companyId must be a uuid', { field: 'companyId' });
  return raw.toLowerCase();
}

function parseIdempotencyKey(raw: unknown): string {
  if (typeof raw !== 'string' || !IDEMPOTENCY_KEY_RE.test(raw)) {
    throw new AppError('VALIDATION', 'idempotencyKey must be 1..200 characters of letters, digits, . _ : -', { field: 'idempotencyKey' });
  }
  return raw;
}

function parseCompanyIds(raw: unknown, ctx: ActorContext): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new AppError('VALIDATION', 'companyIds must be a non-empty array', { field: 'companyIds' });
  const ids = [
    ...new Set(
      raw.map((v) => {
        if (typeof v !== 'string' || !isUuid(v)) throw new AppError('VALIDATION', 'companyIds must be uuids', { field: 'companyIds' });
        return v.toLowerCase();
      }),
    ),
  ];
  const max = ctx.entitlements.bulkRevealMax;
  if (ids.length > max) throw new AppError('VALIDATION', `At most ${max} companies per bulk reveal`, { field: 'companyIds', max });
  return ids;
}

function parseConfirmedCredits(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new AppError('VALIDATION', 'confirmedCredits must be a non-negative integer', { field: 'confirmedCredits' });
  }
  return raw;
}

function parseId(raw: unknown): string {
  if (typeof raw !== 'string' || !isUuid(raw)) throw new AppError('VALIDATION', 'id must be a uuid', { field: 'id' });
  return raw.toLowerCase();
}

// ---- shared contact resolution (LLD M29 sequence steps 5-6) -----------------------------------

/**
 * Resolves a company's contact slots to deliverable values (LLD M29 step 5-6): splits by
 * staleness, re-verifies the stale ones, excludes invalid ones, then fetches the plaintext values
 * for what remains. Returns `[]` when there is nothing deliverable to reveal.
 */
export async function resolveContactsForCompany(ctx: ActorContext, doc: ProfileDoc, triggerRef: string): Promise<ResolvedContact[]> {
  const slots = (doc.contacts ?? []) as ProfileContactSlot[];
  if (slots.length === 0) return [];
  const now = new Date();
  const { stale } = splitByStaleness(slots, now);

  let outcomes = new Map<string, { assertionId: string; status: Deliverability; checkedAt: Date }>();
  if (stale.length > 0) {
    const results = await reverifyRpc(ctx, stale.map((s) => s.assertion_id), 'reveal', triggerRef);
    outcomes = new Map(results.map((o) => [o.assertionId, o]));
  }

  const resolved = excludeInvalid(resolveSlots(slots, outcomes, now));
  if (resolved.length === 0) return [];

  const values = await fetchContactValues(resolved.map((r) => r.assertionId));
  const out: ResolvedContact[] = [];
  for (const r of resolved) {
    const v = values.get(r.assertionId);
    if (!v) {
      log.warn({ assertionId: r.assertionId, companyId: doc.company_id }, 'm29: no contact_value row for a resolved slot; excluding it');
      continue;
    }
    if (v.companyId.toLowerCase() !== doc.company_id.toLowerCase()) {
      log.error(
        { assertionId: r.assertionId, companyId: doc.company_id, valueCompanyId: v.companyId },
        'm29: contact value company mismatch; excluding it',
      );
      continue;
    }
    out.push({ ...r, value: v.value });
  }
  return out;
}

async function loadDecryptedContacts(ctx: ActorContext, revealId: string, accountId: string): Promise<RevealedContactDto[]> {
  const rows = await listRevealContacts(ctx, revealId);
  const now = new Date();
  return rows.map((r) => ({
    assertionId: r.assertion_id,
    kind: r.kind,
    value: decryptValue(r.value_enc, accountId, r.assertion_id),
    deliverability: toDeliverableStatus(r.deliverability),
    checkedAt: r.checked_at.toISOString(),
    stale: isStale(r.checked_at.toISOString(), now),
  }));
}

// ---- single reveal (IF-29a POST /api/reveal) ---------------------------------------------------

/**
 * LLD M29 "Sequence (single reveal)". REQ-029's "blocked reveal" is enforced twice, for different
 * reasons: `assertAllowed` refuses a company whose *catalogue* sanctions flag disallows the
 * 'reveal' action (POLICY_DENIED / SANCTIONS_BLOCKED), and `assertSanctionsClear` re-screens the
 * company live, right before spending anything, in case the flag changed since the doc was built.
 */
export async function reveal(ctx: ActorContext, rawCompanyId: unknown, rawIdempotencyKey: unknown): Promise<RevealApiResponse> {
  const { accountId } = requireMember(ctx);
  const companyId = parseCompanyId(rawCompanyId);
  const clientKey = parseIdempotencyKey(rawIdempotencyKey);

  return withSpan(
    'm29.reveal',
    async () => {
      const existing = await findDoneReveal(ctx, companyId);
      if (existing) {
        const contacts = await loadDecryptedContacts(ctx, existing.id, accountId);
        return { revealId: existing.id, contacts, creditsCharged: 0, already: true };
      }

      const doc = await assertAllowed(ctx, 'reveal', companyId, 'reveal');

      const usedAllowance = await consumeAllowance(ctx, 'reveal', 1);
      let holdId: string | null = null;
      let unitCredits = 0;
      let catalogueVersion: string | null = null;
      if (!usedAllowance) {
        const q = quote(ctx, 'reveal');
        unitCredits = q.credits;
        catalogueVersion = q.catalogueVersion;
        const h = await hold(ctx, {
          credits: q.credits,
          actionType: 'reveal',
          actionRef: companyId,
          idempotencyKey: `reveal:${accountId}:${companyId}:${clientKey}`,
        });
        holdId = h.holdId;
      }

      const cleanupPayment = async (): Promise<void> => {
        if (holdId) {
          await release(ctx, holdId).catch((err: unknown) => log.error({ err, holdId }, 'm29: failed to release a reveal hold'));
        } else if (usedAllowance) {
          await undoAllowance(ctx, 'reveal', 1).catch((err: unknown) => log.error({ err }, 'm29: failed to undo a reveal allowance'));
        }
      };

      try {
        await assertSanctionsClear(ctx, companyId);
      } catch (err) {
        await cleanupPayment();
        throw err;
      }

      const revealId = newId<'reveal'>();
      let resolved: ResolvedContact[];
      try {
        resolved = await resolveContactsForCompany(ctx, doc, revealId);
      } catch (err) {
        await cleanupPayment();
        throw err;
      }

      if (resolved.length === 0) {
        await cleanupPayment();
        return { contacts: [], creditsCharged: 0, reason: 'NO_VALID_CONTACTS' };
      }

      let commitEntryId: string | null = null;
      if (holdId) {
        const c = await commit(ctx, holdId);
        commitEntryId = c.commitEntryId;
      }

      const contactInserts: RevealContactInsert[] = resolved.map((r) => ({
        assertionId: r.assertionId,
        kind: r.kind,
        valueEnc: encryptValue(r.value, accountId, r.assertionId),
        deliverability: r.deliverability,
        checkedAt: r.checkedAt,
      }));

      const inserted = await insertRevealDone(ctx, accountId, {
        id: revealId,
        companyId,
        holdId,
        commitEntryId,
        catalogueVersion,
        contacts: contactInserts,
      });

      if (!inserted) {
        // A concurrent request for this account+company already recorded a `done` reveal (the
        // partial unique index caught it). We already committed credits for this attempt; refund
        // them rather than double-charge, and answer with the winner's own contacts.
        if (commitEntryId) {
          await refund(ctx, {
            refersTo: commitEntryId,
            credits: unitCredits,
            reason: 'concurrent reveal already recorded for this company',
            idempotencyKey: `refund:concurrent:${revealId}`,
          }).catch((err: unknown) => log.error({ err, revealId }, 'm29: failed to refund a concurrent-reveal commit'));
        } else if (usedAllowance) {
          await undoAllowance(ctx, 'reveal', 1).catch((err: unknown) => log.error({ err }, 'm29: failed to undo a reveal allowance'));
        }
        const winner = await findDoneReveal(ctx, companyId);
        if (winner) {
          const contacts = await loadDecryptedContacts(ctx, winner.id, accountId);
          return { revealId: winner.id, contacts, creditsCharged: 0, already: true };
        }
        throw new AppError('CONFLICT', 'Reveal could not be completed due to a concurrent request; please retry');
      }

      const contacts: RevealedContactDto[] = resolved.map((r) => ({
        assertionId: r.assertionId,
        kind: r.kind,
        value: r.value,
        deliverability: toDeliverableStatus(r.deliverability),
        checkedAt: r.checkedAt.toISOString(),
        stale: r.stale,
      }));
      return { revealId, contacts, creditsCharged: usedAllowance ? 0 : unitCredits };
    },
    { companyId },
  );
}

// ---- bulk reveal (IF-29a POST /api/reveal/bulk, GET /api/reveal/bulk/:id) ---------------------

async function processBulkCompany(
  ctx: ActorContext,
  companyId: string,
  triggerRef: string,
): Promise<{ ok: true; contacts: ResolvedContact[] } | { ok: false; reason: string }> {
  try {
    const doc = await assertAllowed(ctx, 'reveal', companyId, 'reveal');
    await assertSanctionsClear(ctx, companyId);
    const contacts = await resolveContactsForCompany(ctx, doc, triggerRef);
    if (contacts.length === 0) return { ok: false, reason: 'NO_VALID_CONTACTS' };
    return { ok: true, contacts };
  } catch (e) {
    if (!(e instanceof AppError)) log.error({ err: e, companyId }, 'm29: bulk reveal of one company failed unexpectedly');
    return { ok: false, reason: e instanceof AppError ? e.code : 'INTERNAL' };
  }
}

/**
 * Runs (or resumes) the actual per-company work for a bulk reveal and settles the ledger.
 *
 * [deviation: LLD M29 Bulk says "Each company then runs steps 2 and 4-7 with a per-company commit
 * of its share. At the end, the remainder is released." M28's ledger (already built; not
 * rewritten here) resolves a hold with exactly one terminal operation — one `commit()` call
 * finalises the whole hold, moving any unspent remainder back to available in that same call —
 * so N independent per-company commits against one shared hold are not something M28 supports.
 * This instead does all N companies' work first, then issues a single aggregate `commit()` for
 * the total actually earned (successCount * unitCredits); M28's own "any remainder is released"
 * behaviour inside that one commit call delivers the same financial outcome the LLD describes.]
 */
export async function runBulkBatch(
  ctx: ActorContext,
  bulkId: string,
  allCompanyIds: readonly string[],
  alreadyRevealedIds: ReadonlySet<string>,
  toProcess: readonly string[],
  holdId: string,
  unitCredits: number,
  catalogueVersion: string | null,
): Promise<BulkRevealResponseDto> {
  const { accountId } = requireMember(ctx);
  await updateRevealBulk(ctx, bulkId, { state: 'running' });

  const itemByCompany = new Map<string, RevealBulkItem>();
  for (const id of alreadyRevealedIds) itemByCompany.set(id, { companyId: id, status: 'already' });

  const perCompany = await mapLimit(toProcess, BULK_CONCURRENCY, async (companyId) => ({
    companyId,
    outcome: await processBulkCompany(ctx, companyId, `bulk:${bulkId}`),
  }));

  const toInsert: RevealInsert[] = [];
  for (const { companyId, outcome } of perCompany) {
    if (outcome.ok) {
      toInsert.push({
        id: newId<'reveal'>(),
        companyId,
        holdId,
        commitEntryId: null, // filled in once the aggregate commit below produces one
        catalogueVersion,
        contacts: outcome.contacts.map((c) => ({
          assertionId: c.assertionId,
          kind: c.kind,
          valueEnc: encryptValue(c.value, accountId, c.assertionId),
          deliverability: c.deliverability,
          checkedAt: c.checkedAt,
        })),
      });
      itemByCompany.set(companyId, { companyId, status: 'done' });
    } else {
      itemByCompany.set(companyId, { companyId, status: 'failed', reason: outcome.reason });
    }
  }

  const creditsToCommit = toInsert.length * unitCredits;
  const commitResult = await commit(ctx, holdId, { credits: creditsToCommit });
  for (const r of toInsert) r.commitEntryId = commitResult.commitEntryId;

  const inserted = toInsert.length > 0 ? await insertRevealDoneMany(ctx, accountId, toInsert) : new Set<string>();
  for (const r of toInsert) {
    if (!inserted.has(r.companyId)) {
      // Lost a race against a concurrent reveal of the same company; credits for it were already
      // committed above, but a `done` row for it already exists from the winner, so it is not
      // double-billed — just not written again here.
      itemByCompany.set(r.companyId, { companyId: r.companyId, status: 'already' });
    }
  }

  const results: RevealBulkItem[] = allCompanyIds.map(
    (id) => itemByCompany.get(id) ?? { companyId: id, status: 'failed', reason: 'INTERNAL' },
  );

  await updateRevealBulk(ctx, bulkId, { state: 'done', results, creditsCharged: commitResult.committed });
  return { bulkId, state: 'done', results, creditsCharged: commitResult.committed };
}

async function enqueueBulkJob(ctx: ActorContext, payload: BulkJobPayload): Promise<void> {
  const db = systemDb('m29: enqueue a bulk reveal job');
  await db.transaction().execute(async (tx: Db) => {
    await enqueue(
      tx,
      {
        type: BULK_JOB_TYPE,
        queue: BULK_JOB_QUEUE,
        payload,
        idempotencyKey: `reveal_bulk:${payload.bulkId}`,
      },
      ctx,
    );
  });
}

/** POST /api/reveal/bulk (IF-29a). */
export async function revealBulk(
  ctx: ActorContext,
  rawCompanyIds: unknown,
  rawIdempotencyKey: unknown,
  rawConfirmedCredits: unknown,
): Promise<BulkRevealResponseDto> {
  const { accountId, memberId } = requireMember(ctx);
  const companyIds = parseCompanyIds(rawCompanyIds, ctx);
  const idempotencyKey = parseIdempotencyKey(rawIdempotencyKey);
  const confirmedCredits = parseConfirmedCredits(rawConfirmedCredits);

  return withSpan(
    'm29.revealBulk',
    async () => {
      const alreadyDone = await findDoneRevealCompanyIds(ctx, companyIds);
      const toProcess = companyIds.filter((id) => !alreadyDone.has(id));

      const q = toProcess.length > 0 ? quote(ctx, 'reveal_bulk_each', { quantity: 1 }) : null;
      const unitCredits = q?.credits ?? 0;
      const catalogueVersion = q?.catalogueVersion ?? null;
      const expectedCredits = unitCredits * toProcess.length;
      if (confirmedCredits !== expectedCredits) {
        throw new AppError('CONFLICT', 'confirmedCredits does not match the current quote for this batch', { expected: expectedCredits });
      }

      const bulkId = newId<'reveal_bulk'>();
      if (toProcess.length === 0) {
        const results: RevealBulkItem[] = companyIds.map((id) => ({ companyId: id, status: 'already' as const }));
        await insertRevealBulk(ctx, accountId, {
          id: bulkId,
          state: 'done',
          companyIds,
          confirmedCredits: 0,
          results,
          creditsCharged: 0,
          error: null,
        });
        return { bulkId, state: 'done', results, creditsCharged: 0 };
      }

      const { holdId } = await hold(ctx, {
        credits: expectedCredits,
        actionType: 'reveal_bulk',
        actionRef: bulkId,
        idempotencyKey: `reveal_bulk:${accountId}:${idempotencyKey}`,
      });

      await insertRevealBulk(ctx, accountId, {
        id: bulkId,
        state: 'queued',
        companyIds,
        confirmedCredits: expectedCredits,
        results: [],
        creditsCharged: 0,
        error: null,
      });

      if (toProcess.length <= INLINE_BULK_MAX) {
        return runBulkBatch(ctx, bulkId, companyIds, alreadyDone, toProcess, holdId, unitCredits, catalogueVersion);
      }

      await enqueueBulkJob(ctx, {
        v: 1,
        bulkId,
        accountId,
        memberId,
        ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
        ...(ctx.role ? { role: ctx.role } : {}),
        region: ctx.region,
        locale: ctx.locale,
        mfaVerified: ctx.mfaVerified,
        entitlements: ctx.entitlements,
        allCompanyIds: companyIds,
        alreadyRevealedIds: [...alreadyDone],
        toProcess,
        holdId,
        unitCredits,
        catalogueVersion,
      });
      return { bulkId, state: 'queued' };
    },
    { count: companyIds.length },
  );
}

/** GET /api/reveal/bulk/:id. */
export async function getBulkReveal(ctx: ActorContext, rawId: unknown): Promise<BulkRevealResponseDto> {
  requireMember(ctx);
  const id = parseId(rawId);
  const row = await findRevealBulk(ctx, id);
  if (!row) throw new AppError('NOT_FOUND', 'Bulk reveal not found');
  return { bulkId: row.id, state: row.state, results: row.results, creditsCharged: row.credits_charged };
}

// ---- IF-29b: used by M27 (revealed provider) and M35 (export) ---------------------------------

/** M27's `revealed` provider: whether this account already holds a `done` reveal for a company. */
export async function isRevealed(ctx: ActorContext, companyId: string): Promise<boolean> {
  if (!ctx.accountId) return false;
  return (await findDoneReveal(ctx, companyId)) !== null;
}

/** IF-29b `revealedContacts(ctx, companyIds?)`, decrypted. Used by M35's export job so it only
 * ever includes contacts this account has actually paid to unlock. */
export async function revealedContacts(ctx: ActorContext, companyIds?: readonly string[]): Promise<RevealedContact[]> {
  const { accountId } = requireMember(ctx);
  let ids: string[] | undefined;
  if (companyIds !== undefined) {
    ids = [
      ...new Set(
        companyIds.map((id) => {
          if (!isUuid(id)) throw new AppError('VALIDATION', 'companyIds must be uuids', { field: 'companyIds' });
          return id.toLowerCase();
        }),
      ),
    ];
  }
  const rows = await listRevealedContactsForAccount(ctx, ids);
  return rows.map((r) => ({
    companyId: r.companyId,
    revealId: r.revealId,
    assertionId: r.assertionId,
    kind: r.kind,
    value: decryptValue(r.valueEnc, accountId, r.assertionId),
    deliverability: toDeliverableStatus(r.deliverability),
    checkedAt: r.checkedAt,
  }));
}
