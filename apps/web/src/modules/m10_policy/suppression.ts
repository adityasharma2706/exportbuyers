/**
 * M10 — global suppression list (DS-06).
 *
 *   IF-10c isSuppressed(kind, raw), normHash(kind, raw), anySuppressed(hashes)
 *   IF-10d suppress(tx, entries, reason, reviewItemId?) — inserts the hashes and emits EV-04
 *          `suppression.added {hashes}` in the caller's transaction.
 *
 * Only hashes are stored; raw identifiers are never written or logged.
 */
import { z } from 'zod';
import { AppError, isUuid, log, systemDb } from '../m01_platform/index.js';
import { emit, registerEventSchema, type Tx } from '../m02_queue/index.js';
import { bumpPolicyGen } from './cache.js';
import { isIdentifierKind, normHash } from './normalise.js';
import { execFromDb, insertSuppression, suppressedAmong } from './readModelStore.js';
import { SUPPRESSION_REASONS, type IdentifierKind, type SuppressionReason } from './types.js';

/** EV-04 (HLD): same event type name the Python knowledge plane subscribes to. */
export const EV_SUPPRESSION_ADDED = 'suppression.added';

const HASH_RE = /^[0-9a-f]{64}$/;

export const suppressionAddedSchema = z.object({
  hashes: z.array(z.string().regex(HASH_RE)).min(1).max(10_000),
});
export type SuppressionAdded = z.infer<typeof suppressionAddedSchema>;

let schemaRegistered = false;
export function registerSuppressionEventSchema(): void {
  if (schemaRegistered) return;
  registerEventSchema(EV_SUPPRESSION_ADDED, suppressionAddedSchema);
  schemaRegistered = true;
}

function readDb() {
  return execFromDb(systemDb('m10 suppression list lookup'));
}

/** IF-10c. Whether the identifier is on the suppression list. */
export async function isSuppressed(kind: IdentifierKind, raw: string): Promise<boolean> {
  const h = normHash(kind, raw);
  const hit = await suppressedAmong(readDb(), [h]);
  return hit.has(h);
}

/** IF-10c batch form: the subset of `hashes` that is suppressed. */
export async function anySuppressed(hashes: readonly string[]): Promise<Set<string>> {
  const hs = [...new Set(hashes)].filter((h) => HASH_RE.test(h));
  if (hs.length === 0) return new Set();
  return suppressedAmong(readDb(), hs);
}

export interface SuppressionEntry {
  kind: IdentifierKind;
  raw: string;
}

/**
 * IF-10d. Adds the entries to the suppression list and emits EV-04 in `tx`, so the list and
 * the purge event commit together. The EV-04 handlers (M10 here, M09, M26, M35) remove the
 * read models; until they run, every read path already excludes the company through the
 * suppression subquery, and the policy cache generation is bumped so no cached result
 * survives.
 */
export async function suppress(
  tx: Tx,
  entries: ReadonlyArray<SuppressionEntry>,
  reason: SuppressionReason,
  reviewItemId?: string,
): Promise<void> {
  if (!Array.isArray(entries) || entries.length === 0) throw new AppError('VALIDATION', 'suppress() needs at least one entry');
  if (!SUPPRESSION_REASONS.includes(reason)) throw new AppError('VALIDATION', `Invalid suppression reason "${String(reason)}"`);
  if (reviewItemId !== undefined && !isUuid(reviewItemId)) throw new AppError('VALIDATION', 'reviewItemId must be a uuid');

  const rows = new Map<string, IdentifierKind>();
  entries.forEach((e, i) => {
    if (!e || !isIdentifierKind(e.kind)) throw new AppError('VALIDATION', `suppress(): entry ${i} has an unknown kind`);
    let h: string;
    try {
      h = normHash(e.kind, e.raw);
    } catch (err) {
      throw new AppError('VALIDATION', `suppress(): entry ${i} (${e.kind}) cannot be normalised`, { index: i, kind: e.kind }, { cause: err });
    }
    if (!rows.has(h)) rows.set(h, e.kind);
  });

  registerSuppressionEventSchema();
  const list = [...rows].map(([hash, kind]) => ({ hash, kind }));
  const inserted = await insertSuppression(execFromDb(tx), list, reason, reviewItemId ?? null);
  // Emit for every hash, including ones already listed: a re-suppression re-runs the purge,
  // which is idempotent, and covers docs rebuilt from data that slipped in before.
  await emit(tx, EV_SUPPRESSION_ADDED, { hashes: list.map((r) => r.hash) });
  await bumpPolicyGen();
  log.info(
    { reason, reviewItemId, entries: list.length, inserted, kinds: [...new Set(list.map((r) => r.kind))] },
    'm10 identifiers suppressed',
  );
}
