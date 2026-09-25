/**
 * M17 — serving-plane side of possible matches (M11 IF-11a/IF-11b).
 *
 *   knowledge plane (screen_company) ──enqueue──▶ `m17.file_possible_match` (serving queue)
 *        ──▶ M11 file('sanctions.possible_match', dedupeKey = company id)
 *   admin resolves `confirmed` | `cleared` ──EV-07──▶ onOutcome:
 *        • M09 IF-09b `sanctions_decision` (writes sanctions_flag {block}, emits EV-03)
 *        • `m17.record_decision` (knowledge queue) so later screens honour the decision
 *
 * While the item is pending the company is already blocked (the knowledge plane sets
 * sanctions_flag block = true for `possible`) [assumption: fail safe].
 */
import { z } from 'zod';
import { log, systemDb } from '../m01_platform/index.js';
import { enqueue, registerHandler, type JobMeta, type Tx } from '../m02_queue/index.js';
import { DEFAULT_SLA_HOURS, file, registerType, sendAssertionCommand } from '../m11_review/index.js';

export const POSSIBLE_MATCH_TYPE = 'sanctions.possible_match';
export const FILE_POSSIBLE_MATCH_JOB = 'm17.file_possible_match';
export const RECORD_DECISION_JOB = 'm17.record_decision';
export const SANCTIONS_OUTCOMES = ['confirmed', 'cleared'] as const;
export type SanctionsOutcome = (typeof SANCTIONS_OUTCOMES)[number];

const LIST_KEYS = ['ofac_sdn', 'ofac_cons', 'un', 'eu', 'uk_ofsi'] as const;

export const possibleMatchPayloadSchema = z.object({
  companyId: z.string().uuid(),
  companyName: z.string().min(1).max(500),
  country: z.string().regex(/^[A-Z]{2}$/).nullable(),
  bestScore: z.number().min(0).max(100),
  matches: z
    .array(
      z.object({
        entryId: z.string().uuid(),
        list: z.enum(LIST_KEYS),
        listUid: z.string().min(1).max(200),
        name: z.string().max(1000),
        score: z.number().min(0).max(100),
      }),
    )
    .max(50),
  listVersions: z.record(z.string()),
  screenedAt: z.string().max(64),
});
export type PossibleMatchPayload = z.infer<typeof possibleMatchPayloadSchema>;

export const possibleMatchOutcomeSchema = z.object({ note: z.string().max(2000).optional() });
export type PossibleMatchOutcome = z.infer<typeof possibleMatchOutcomeSchema>;

function isSanctionsOutcome(o: string): o is SanctionsOutcome {
  return (SANCTIONS_OUTCOMES as readonly string[]).includes(o);
}

/** Files (or, on a dedupe hit, finds) the open review item for a possible match. */
export async function filePossibleMatch(tx: Tx, p: PossibleMatchPayload): Promise<string> {
  return file(tx, POSSIBLE_MATCH_TYPE, {
    subjectRefs: [{ kind: 'company', id: p.companyId }],
    payload: p,
    filedBy: { kind: 'system', ref: 'm17.sanctions' },
    dedupeKey: p.companyId,
  });
}

async function onFilePossibleMatch(p: PossibleMatchPayload, meta: JobMeta): Promise<void> {
  const id = await systemDb('m17 file sanctions possible match')
    .transaction()
    .execute(async (tx: Tx) => filePossibleMatch(tx, p));
  log.info({ companyId: p.companyId, reviewItemId: id, bestScore: p.bestScore, jobId: meta.jobId }, 'm17 possible match filed');
}

let registered = false;

/** Registers the review type and the filing job. Call at boot (web and worker), before M02's syncRegistrations(). */
export function registerSanctionsModule(): void {
  if (registered) return;
  registerType<PossibleMatchPayload, PossibleMatchOutcome>({
    type: POSSIBLE_MATCH_TYPE,
    payloadSchema: possibleMatchPayloadSchema,
    outcomes: SANCTIONS_OUTCOMES,
    outcomeSchema: possibleMatchOutcomeSchema,
    slaHours: DEFAULT_SLA_HOURS.sanctionsPossibleMatch,
    requiredRole: 'admin_ops',
    view: {
      titleKey: 'admin.review.sanctions.title',
      fields: [
        { path: 'companyName', labelKey: 'admin.review.sanctions.company' },
        { path: 'country', labelKey: 'admin.review.sanctions.country' },
        { path: 'bestScore', labelKey: 'admin.review.sanctions.bestScore' },
        { path: 'matches', labelKey: 'admin.review.sanctions.matches', format: 'json' },
        { path: 'listVersions', labelKey: 'admin.review.sanctions.listVersions', format: 'json' },
        { path: 'screenedAt', labelKey: 'admin.review.sanctions.screenedAt', format: 'datetime' },
      ],
      outcomeLabelKeys: { confirmed: 'admin.review.sanctions.confirm', cleared: 'admin.review.sanctions.clear' },
      confirmOutcomes: ['confirmed', 'cleared'],
    },
    onOutcome: async (item, outcome, data, tx: Tx) => {
      if (!isSanctionsOutcome(outcome)) return; // M11 validates outcomes; defensive only
      const companyId = item.payload.companyId;
      await sendAssertionCommand(tx, item, {
        kind: 'sanctions_decision',
        subjectId: companyId,
        payload: { decision: outcome },
      });
      await enqueue(tx, {
        type: RECORD_DECISION_JOB,
        queue: 'knowledge',
        payload: { company_id: companyId, decision: outcome, review_item_id: item.id },
        idempotencyKey: `m17:${item.id}:${outcome}`,
      });
      log.info({ itemId: item.id, companyId, outcome, note: data.note }, 'm17 sanctions decision recorded');
    },
  });
  registerHandler(FILE_POSSIBLE_MATCH_JOB, possibleMatchPayloadSchema, onFilePossibleMatch);
  registered = true;
}

export function resetSanctionsModuleForTesting(): void {
  registered = false;
}
