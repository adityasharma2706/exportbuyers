/**
 * M33 — event wiring and the M27 shortlist provider.
 *
 *   EV-09 draft.left_product (from M34, once it exists) -> auto-sets `to_contact` → `contacted`
 *     (LLD M33 Rules), which itself re-emits EV-08 pipeline.status_changed.
 *   IF-27 `registerProvider('shortlist', ...)`: M27's reserved shortlist-entry slot (status +
 *     notes count + drafts count placeholder) is filled here, the same way M30 fills M10's
 *     `userHides` slot from its own jobs.ts.
 *
 * Call registerPipelineModule() once at boot (web and worker), before M02's syncRegistrations().
 */
import { z } from 'zod';
import { log, scoped } from '../m01_platform/index.js';
import { registerEventSchema, subscribe, type EventMeta } from '../m02_queue/index.js';
import { registerProvider } from '../m27_buyer_profile/index.js';
import { notesCountByEntry } from './repo.js';
import { handleDraftLeftProduct } from './service.js';
import { EV_DRAFT_LEFT_PRODUCT, EV_PIPELINE_STATUS_CHANGED, SHORTLIST_STATUSES, type DraftLeftProductPayload } from './types.js';

const pipelineStatusChangedSchema = z.object({
  v: z.literal(1),
  entryId: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  companyId: z.string().uuid(),
  fromStatus: z.enum(SHORTLIST_STATUSES).nullable(),
  toStatus: z.enum(SHORTLIST_STATUSES),
  source: z.enum(['user', 'auto_draft']),
  at: z.string(),
});

export const draftLeftProductSchema = z.object({
  v: z.literal(1),
  entryId: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  companyId: z.string().uuid(),
  via: z.enum(['copy', 'mailto', 'wa']),
  at: z.string(),
});

async function onDraftLeftProduct(payload: DraftLeftProductPayload, meta: EventMeta): Promise<void> {
  await handleDraftLeftProduct(meta.tx, payload.entryId, new Date());
}

let registered = false;

export function registerPipelineModule(): void {
  if (registered) return;

  registerProvider('shortlist', {
    // `serving.shortlist_entry` is account-scoped (repo.ts), so `scoped(ctx)` needs no
    // workspaceId of its own here; the workspace filter below is an explicit predicate, the
    // same way M07 filters `serving.workspace` rows by id rather than by ctx.workspaceId.
    async entryFor(ctx, workspaceId, companyId) {
      const sdb = scoped(ctx);
      const row = (await sdb
        .selectFrom('serving.shortlist_entry')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('company_id', '=', companyId)
        .executeTakeFirst()) as Record<string, unknown> | undefined;
      if (!row) return null;
      const counts = await notesCountByEntry(sdb, [String(row.id)]);
      return {
        status: String(row.status),
        notesCount: counts.get(String(row.id)) ?? 0,
        draftsCount: 0, // M34 (drafts) does not exist yet; filled once it registers its own count.
      };
    },
  });

  registerEventSchema(EV_PIPELINE_STATUS_CHANGED, pipelineStatusChangedSchema);
  registerEventSchema(EV_DRAFT_LEFT_PRODUCT, draftLeftProductSchema);
  subscribe(EV_DRAFT_LEFT_PRODUCT, 'm33.auto_contacted', async (payload, meta) => {
    try {
      await onDraftLeftProduct(payload, meta);
    } catch (err) {
      log.error({ err, entryId: payload.entryId }, 'm33: failed to apply auto-contacted status');
      throw err;
    }
  });

  registered = true;
}

/** Test hook. */
export function resetPipelineModuleForTesting(): void {
  registered = false;
}
