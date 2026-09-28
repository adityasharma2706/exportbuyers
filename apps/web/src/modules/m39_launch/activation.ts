/**
 * M39 — activation-metric instrumentation (LLD M39 #6): "analytics.activation(account_id,
 * saved_count, drafted bool, activated_at), fed by EV-08 and EV-09." REQ-057 (acceptance bar).
 *
 * "Activated" = at least `savedThreshold` (default 5) buyers saved to a shortlist, AND at least
 * `draftedThreshold` (default 1) outreach draft sent, config.ts.
 *
 * [deviation: M33 (already built) only emits EV-08 `pipeline.status_changed` on a *status
 * transition* (`updateShortlistStatus` / the EV-09 auto-contacted handler) — `addToShortlist`'s
 * initial insert (`insertEntryIfAbsent`, m33_pipeline/repo.ts) writes no status_history row and
 * emits nothing, so there is no event that fires the moment a buyer is first "saved". Per the
 * pipeline's rule against rewriting an earlier module's files, `saved_count` here is instead kept
 * current by a periodic recompute job (`recomputeSavedCounts`, scheduled daily) that counts
 * `serving.shortlist_entry` rows directly — the source of truth "saved" already is. EV-08 is
 * still consumed, exactly as the LLD asks: every `pipeline.status_changed` whose
 * `source = 'auto_draft'` (the M33 Rules' own "draft left the product -> auto-contacted"
 * transition) also confirms `drafted = true`, redundantly with EV-09 below. EV-09
 * `draft.left_product` (M34) is the primary, immediate signal for `drafted`.]
 */
import { sql } from 'kysely';
import { log, systemDb } from '../m01_platform/index.js';
import { registerHandler, registerSchedule, subscribe, type EventMeta, type PayloadSchema } from '../m02_queue/index.js';
import {
  EV_DRAFT_LEFT_PRODUCT,
  EV_PIPELINE_STATUS_CHANGED,
  type DraftLeftProductPayload,
  type PipelineStatusChangedPayload,
} from '../m33_pipeline/index.js';
import { launchHardeningConfig } from './config.js';

export interface ActivationRow {
  accountId: string;
  savedCount: number;
  drafted: boolean;
  activatedAt: Date | null;
  updatedAt: Date;
}

interface RawActivationRow {
  account_id: string;
  saved_count: number | string;
  drafted: boolean;
  activated_at: Date | string | null;
  updated_at: Date | string;
}

function mapRow(r: RawActivationRow): ActivationRow {
  return {
    accountId: r.account_id,
    savedCount: Number(r.saved_count),
    drafted: r.drafted,
    activatedAt: r.activated_at ? new Date(r.activated_at) : null,
    updatedAt: new Date(r.updated_at),
  };
}

export async function getActivation(accountId: string): Promise<ActivationRow | undefined> {
  const rows = await sql<RawActivationRow>`select * from analytics.activation where account_id = ${accountId}`.execute(
    systemDb('m39: read activation row'),
  );
  return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
}

/**
 * Upserts one account's activation row. Only the fields present in `patch` are changed;
 * `activated_at` is set (once, permanently) the first time the row satisfies both thresholds.
 * Not transactionally isolated across concurrent writers for the same account (an analytics
 * feed, not the credits ledger) — the same tolerance M01's cost-event buffer accepts.
 */
export async function upsertActivation(accountId: string, patch: { savedCount?: number; drafted?: boolean }, now: Date = new Date()): Promise<void> {
  const cfg = launchHardeningConfig().activation;
  const existing = await getActivation(accountId);
  const savedCount = patch.savedCount ?? existing?.savedCount ?? 0;
  const drafted = patch.drafted ?? existing?.drafted ?? false;
  const alreadyActivated = existing?.activatedAt ?? null;
  const nowlyActivated = savedCount >= cfg.savedThreshold && drafted;
  const activatedAt = alreadyActivated ?? (nowlyActivated ? now : null);

  await sql`
    insert into analytics.activation (account_id, saved_count, drafted, activated_at, updated_at)
    values (${accountId}, ${savedCount}, ${drafted}, ${activatedAt}, ${now})
    on conflict (account_id) do update
      set saved_count = excluded.saved_count,
          drafted     = excluded.drafted,
          activated_at = coalesce(analytics.activation.activated_at, excluded.activated_at),
          updated_at  = excluded.updated_at
  `.execute(systemDb('m39: upsert activation row'));
}

// ---- event handlers -----------------------------------------------------------------------------

async function onDraftLeftProduct(payload: DraftLeftProductPayload, _meta: EventMeta): Promise<void> {
  await upsertActivation(payload.accountId, { drafted: true }, new Date(payload.at));
}

async function onPipelineStatusChanged(payload: PipelineStatusChangedPayload, _meta: EventMeta): Promise<void> {
  if (payload.source !== 'auto_draft') return; // only the "a draft just left the product" transition confirms drafted
  await upsertActivation(payload.accountId, { drafted: true }, new Date(payload.at));
}

// ---- periodic saved_count recompute --------------------------------------------------------------

export interface SavedCountRow {
  accountId: string;
  savedCount: number;
}

/** One row per account that has ever saved a buyer (LLD "saved" = a live shortlist_entry row). */
export async function savedCountsByAccount(): Promise<SavedCountRow[]> {
  const rows = await sql<{ account_id: string; n: string | number }>`
    select account_id, count(*) as n from serving.shortlist_entry group by account_id
  `.execute(systemDb('m39: recompute saved counts'));
  return rows.rows.map((r) => ({ accountId: r.account_id, savedCount: Number(r.n) }));
}

export async function recomputeSavedCounts(now: Date = new Date()): Promise<number> {
  const rows = await savedCountsByAccount();
  for (const row of rows) {
    try {
      await upsertActivation(row.accountId, { savedCount: row.savedCount }, now);
    } catch (err) {
      log.error({ err, accountId: row.accountId }, 'm39: failed to recompute saved_count for an account');
    }
  }
  return rows.length;
}

// ---- registration ---------------------------------------------------------------------------------

export const RECOMPUTE_SAVED_COUNTS_JOB = 'm39.recompute_saved_counts';

const v1Schema: PayloadSchema<{ v: 1 }> = {
  safeParse(input: unknown) {
    if (input !== null && typeof input === 'object' && (input as { v?: unknown }).v === 1) {
      return { success: true, data: { v: 1 } };
    }
    return { success: false, error: { message: 'payload must be {v:1}' } };
  },
};

let registered = false;

/** Wires the EV-08/EV-09 subscriptions and the daily saved_count recompute job. Idempotent; call
 * once at boot (web and worker), after M33 and M34 have loaded. */
export function registerActivationTracking(): void {
  if (registered) return;
  subscribe(EV_DRAFT_LEFT_PRODUCT, 'm39.activation_drafted', onDraftLeftProduct);
  subscribe(EV_PIPELINE_STATUS_CHANGED, 'm39.activation_from_status', onPipelineStatusChanged);
  registerHandler(RECOMPUTE_SAVED_COUNTS_JOB, v1Schema, async () => {
    const n = await recomputeSavedCounts();
    log.info({ accounts: n }, 'm39: saved_count recompute complete');
  });
  // Daily, 02:15 UTC [tunable] — after the day's activity has settled.
  registerSchedule('m39-recompute-saved-counts', '15 2 * * *', RECOMPUTE_SAVED_COUNTS_JOB, { v: 1 }, 'serving');
  registered = true;
}

/** For tests. */
export function resetActivationTrackingForTesting(): void {
  registered = false;
}
