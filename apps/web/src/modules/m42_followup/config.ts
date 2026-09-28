/**
 * M42 — tunables and the "next follow-up" state machine (LLD M42 Rules: "At most 2 follow-ups per
 * thread"; "Suggested timing: +5 days and +12 days after left_at [tunable]").
 */
import { AppError } from '../m01_platform/index.js';
import type { DraftKind } from '../m34_draft/index.js';
import type { FollowUpDraftKind } from './types.js';

export interface FollowUpConfig {
  /** Days after the first-contact draft leaves the product before follow_up_1 is suggested. */
  followUp1DelayDays: number;
  /** Days after follow_up_1 leaves the product before follow_up_2 is suggested. */
  followUp2DelayDays: number;
  /** LLD M34 sequence step 3, reused here: at most this many company-level evidence snippets. */
  maxEvidenceSnippets: number;
}

const DEFAULT_CONFIG: FollowUpConfig = {
  followUp1DelayDays: 5,
  followUp2DelayDays: 12,
  maxEvidenceSnippets: 5,
};

let config: FollowUpConfig = { ...DEFAULT_CONFIG };

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

export function setFollowUpConfig(patch: Partial<FollowUpConfig>): FollowUpConfig {
  const next = { ...config, ...patch };
  if (!Number.isInteger(next.followUp1DelayDays) || next.followUp1DelayDays < 0) {
    throw new AppError('VALIDATION', 'followUp1DelayDays must be a non-negative integer');
  }
  if (!Number.isInteger(next.followUp2DelayDays) || next.followUp2DelayDays < 0) {
    throw new AppError('VALIDATION', 'followUp2DelayDays must be a non-negative integer');
  }
  if (!Number.isInteger(next.maxEvidenceSnippets) || next.maxEvidenceSnippets < 0) {
    throw new AppError('VALIDATION', 'maxEvidenceSnippets must be a non-negative integer');
  }
  config = next;
  return config;
}

/** Reads M42_FOLLOWUP1_DELAY_DAYS, M42_FOLLOWUP2_DELAY_DAYS, M42_MAX_EVIDENCE_SNIPPETS. */
export function loadFollowUpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FollowUpConfig {
  return setFollowUpConfig({
    followUp1DelayDays: envInt('M42_FOLLOWUP1_DELAY_DAYS') ?? DEFAULT_CONFIG.followUp1DelayDays,
    followUp2DelayDays: envInt('M42_FOLLOWUP2_DELAY_DAYS') ?? DEFAULT_CONFIG.followUp2DelayDays,
    maxEvidenceSnippets: envInt('M42_MAX_EVIDENCE_SNIPPETS') ?? DEFAULT_CONFIG.maxEvidenceSnippets,
  });
}

export function followUpConfig(): FollowUpConfig {
  return config;
}

/** Test hook. */
export function resetFollowUpConfigForTesting(): void {
  config = { ...DEFAULT_CONFIG };
}

/**
 * LLD M42 Rules: "At most 2 follow-ups per thread." The parent draft's own `kind` says which
 * follow-up comes next, or that the thread has already reached its cap. Thrown before anything is
 * generated (mirrors M34's own "nothing is generated" rule for its pre-stream checks).
 */
export function nextFollowUpKind(parentKind: DraftKind): FollowUpDraftKind {
  if (parentKind === 'first') return 'follow_up_1';
  if (parentKind === 'follow_up_1') return 'follow_up_2';
  if (parentKind === 'follow_up_2') {
    throw new AppError(
      'VALIDATION',
      'This thread already has its second follow-up; at most 2 follow-ups are allowed per thread.',
      { field: 'parentId' },
    );
  }
  throw new AppError('VALIDATION', 'This draft cannot be used as a follow-up parent.', { field: 'parentId' });
}

/**
 * LLD M42 Rules: "Suggested timing: +5 days and +12 days after left_at ... After a follow-up
 * leaves the product, createReminder is called for the next one."
 *
 * [deviation: read literally, "a follow-up leaves the product" names only `follow_up_1`/
 * `follow_up_2`, which would leave nothing ever scheduling follow_up_1's own reminder (nothing
 * would "leave the product" to trigger it, since the first-contact draft that starts the thread is
 * kind `'first'`, not a follow-up). The two timing values line up one-to-one with the two
 * follow-ups this module can generate, so this function treats *any* touch leaving the product —
 * `'first'` included — as the trigger for scheduling the next one, each offset counted from that
 * touch's own `left_at` (not the thread's very first `left_at`), which is what makes the module
 * usable end to end.]
 */
export function nextFollowUpAfterHandoff(
  departedKind: DraftKind,
  cfg: FollowUpConfig,
): { kind: FollowUpDraftKind; delayDays: number } | null {
  if (departedKind === 'first') return { kind: 'follow_up_1', delayDays: cfg.followUp1DelayDays };
  if (departedKind === 'follow_up_1') return { kind: 'follow_up_2', delayDays: cfg.followUp2DelayDays };
  return null; // follow_up_2 (or an unrelated kind) leaving ends the thread: no further reminder.
}
