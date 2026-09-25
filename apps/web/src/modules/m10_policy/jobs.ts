/**
 * M10 — event wiring in the TS worker (R2), via M02 IF-02c.
 *
 *   EV-04 suppression.added {hashes}   → delete the matching search/profile docs immediately
 *                                        (documented DELETE grant), enqueue m09.project so the
 *                                        docs are rebuilt without the suppressed identifiers,
 *                                        bump the policy cache generation. No visibility window.
 *   EV-03 sanctions.flag_changed       → bump the policy cache generation.
 *   EV-10 subscription.changed         → bump the account's (or the global) cache generation, so
 *                                        new entitlements apply at once.
 *
 * Call registerPolicyJobs() once at worker boot, before startQueueRuntime().
 */
import { z } from 'zod';
import { log } from '../m01_platform/index.js';
import { enqueue, subscribe, type EventMeta, type Tx } from '../m02_queue/index.js';
import { bumpPolicyGen, invalidateAccountPolicyCache } from './cache.js';
import { companiesCarrying, deleteDocs, execFromDb } from './readModelStore.js';
import { EV_SUPPRESSION_ADDED, registerSuppressionEventSchema, suppressionAddedSchema } from './suppression.js';

export const EV_SANCTIONS_FLAG_CHANGED = 'sanctions.flag_changed';
/** EV-10 PaymentVerified / SubscriptionChanged (published by M36). */
export const EV_SUBSCRIPTION_CHANGED = 'subscription.changed';
export const M09_PROJECT_JOB = 'm09.project';

const subscriptionChangedSchema = z.object({ accountId: z.string().uuid().optional() }).passthrough();

/**
 * The EV-04 purge. Uses the handler's transaction so the deletes, the rebuild jobs and the
 * event_handled marker commit together. Returns the purged company ids.
 */
export async function purgeSuppressed(tx: Tx, hashes: readonly string[], eventId: string): Promise<string[]> {
  const exec = execFromDb(tx);
  const companies = await companiesCarrying(exec, hashes);
  if (companies.length > 0) {
    const removed = await deleteDocs(exec, companies);
    for (const cid of companies) {
      // Same idempotency key shape as M09's own EV-04 handler, so the two collapse into one job.
      await enqueue(tx, {
        type: M09_PROJECT_JOB,
        queue: 'knowledge',
        payload: { company_id: cid },
        idempotencyKey: `${cid}:now:${eventId}`,
      });
    }
    log.info({ companies: companies.length, rowsRemoved: removed, eventId }, 'm10 read models purged for suppression');
  }
  await bumpPolicyGen();
  return companies;
}

async function onSuppressionAdded(payload: unknown, meta: EventMeta): Promise<void> {
  const parsed = suppressionAddedSchema.parse(payload);
  await purgeSuppressed(meta.tx, parsed.hashes, meta.eventId);
}

async function onSanctionsChanged(_payload: unknown, _meta: EventMeta): Promise<void> {
  await bumpPolicyGen();
}

async function onSubscriptionChanged(payload: unknown, _meta: EventMeta): Promise<void> {
  const p = subscriptionChangedSchema.safeParse(payload);
  if (p.success && p.data.accountId) await invalidateAccountPolicyCache(p.data.accountId);
  else await bumpPolicyGen();
}

let registered = false;

export function registerPolicyJobs(): void {
  if (registered) return;
  registerSuppressionEventSchema();
  subscribe(EV_SUPPRESSION_ADDED, 'm10.purge', onSuppressionAdded);
  subscribe(EV_SANCTIONS_FLAG_CHANGED, 'm10.cache', onSanctionsChanged);
  subscribe(EV_SUBSCRIPTION_CHANGED, 'm10.entitlements', onSubscriptionChanged);
  registered = true;
}
