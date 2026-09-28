/**
 * M42 — schedules the "next touch" reminder when a draft leaves the product (LLD M42 Rules:
 * "After a follow-up leaves the product, createReminder is called for the next one").
 *
 * Subscribes to M33's EV-09 `draft.left_product` — the same event M33 itself consumes (in its own
 * events.ts) to auto-set the shortlist entry to 'contacted' — emitted by M34's `handoffDraft()`
 * whenever *any* draft (of any kind: 'first', 'follow_up_1' or 'follow_up_2') records `left_at`.
 *
 * [deviation: M42's declared deps (docs/implementer.md) are only M34 and M41. This file
 * additionally imports M02 (to subscribe to the event) and M33 (for the event's own type/payload/
 * schema, already exported from m33_pipeline/index.js) directly — the same undeclared-but-
 * necessary dependency M34's own repo.ts already took on M33's `serving.shortlist_entry` table,
 * documented there. There is no other way to learn that a draft has left the product: M34's public
 * API exports no such hook of its own, and EV-09's payload (defined by M33, since M34 did not
 * exist yet when M33 was built) carries only `entryId/accountId/workspaceId/companyId/via/at` — no
 * `draftId` or `kind` — so this handler looks the departing draft's row up by
 * `(entry_id, left_at)` to learn which kind just left (repo.ts's `findDraftLeftAround`).]
 *
 * [deviation: IF-41a's `createReminder(ctx, entryId, dueAt, kind)` calls `requireMember(ctx)`
 * internally, which needs a signed-in member's `ActorContext` (`kind: 'user'|'admin'` plus a real
 * `memberId`) — there is no such context inside an M02 event handler, which runs on a system-level
 * `Tx`, not a request (M41's own `notify()` accepts a bare `accountId` for exactly this reason,
 * but `createReminder` has no equivalent system-callable form, and EV-09's payload carries no
 * memberId to reconstruct one from). Rather than fabricate a fake member id to satisfy the guard,
 * this handler writes `serving.reminder` directly (repo.ts's `insertFollowUpReminder`) using
 * IF-41a's own row shape (LLD M41 Schema), so the row is indistinguishable — to M41's own
 * scheduler, dashboard, snooze and complete — from one created through `createReminder` itself.
 * M41's own doc comments already anticipate this module as a caller of its schema ("callers other
 * than this module's own scheduler (M42, M45, ...) may pass any other slug" for
 * `serving.notification.kind`, types.ts) even though the reminder path specifically was not
 * spelled out the same way.]
 */
import { log } from '../m01_platform/index.js';
import { registerEventSchema, subscribe, type EventMeta } from '../m02_queue/index.js';
import { EV_DRAFT_LEFT_PRODUCT, draftLeftProductSchema, type DraftLeftProductPayload } from '../m33_pipeline/index.js';
import { followUpConfig, nextFollowUpAfterHandoff } from './config.js';
import { findDraftLeftAround, hasOpenFollowUpReminder, insertFollowUpReminder } from './repo.js';

async function onDraftLeftProduct(payload: DraftLeftProductPayload, meta: EventMeta): Promise<void> {
  const leftAt = new Date(payload.at);
  const departed = await findDraftLeftAround(meta.tx, payload.entryId, leftAt);
  if (!departed) {
    log.warn(
      { entryId: payload.entryId, at: payload.at },
      'm42: could not find the draft that left the product; no follow-up reminder scheduled',
    );
    return;
  }

  const next = nextFollowUpAfterHandoff(departed.kind, followUpConfig());
  if (!next) return; // follow_up_2 (or an unrelated kind) leaving ends the thread.

  const alreadyScheduled = await hasOpenFollowUpReminder(meta.tx, payload.accountId, payload.entryId, next.kind);
  if (alreadyScheduled) return; // idempotent: a redelivered event never double-books a reminder

  const dueAt = new Date(leftAt.getTime() + next.delayDays * 24 * 3_600_000);
  await insertFollowUpReminder(meta.tx, payload.accountId, payload.entryId, next.kind, dueAt, new Date());
}

let registered = false;

/** Call once at boot (web and worker), after M33's own `registerPipelineModule()` and before M02's
 * `syncRegistrations()` — the same convention M33's events.ts documents for itself. */
export function registerFollowUpModule(): void {
  if (registered) return;

  // Idempotent: M33 registers the same schema for the same event type in its own
  // registerPipelineModule(); registerEventSchema() simply overwrites the same entry.
  registerEventSchema(EV_DRAFT_LEFT_PRODUCT, draftLeftProductSchema);
  subscribe(EV_DRAFT_LEFT_PRODUCT, 'm42.schedule_next_followup', async (payload, meta) => {
    try {
      await onDraftLeftProduct(payload, meta);
    } catch (err) {
      log.error({ err, entryId: payload.entryId }, 'm42: failed to schedule the next follow-up reminder');
      throw err;
    }
  });

  registered = true;
}

/** Test hook. */
export function resetFollowUpModuleForTesting(): void {
  registered = false;
}
