/**
 * M34 — tunables (LLD M34 Rules: "Rate limit: 50 drafts per account per day [tunable]"; sequence
 * step 3: "At most 5 company-level evidence snippets").
 */
import { AppError } from '../m01_platform/index.js';

export interface DraftConfig {
  draftsPerAccountPerDay: number;
  maxEvidenceSnippets: number;
}

const DEFAULT_CONFIG: DraftConfig = {
  draftsPerAccountPerDay: 50,
  maxEvidenceSnippets: 5,
};

let config: DraftConfig = { ...DEFAULT_CONFIG };

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

export function setDraftConfig(patch: Partial<DraftConfig>): DraftConfig {
  const next = { ...config, ...patch };
  if (!Number.isInteger(next.draftsPerAccountPerDay) || next.draftsPerAccountPerDay < 1) {
    throw new AppError('VALIDATION', 'draftsPerAccountPerDay must be a positive integer');
  }
  if (!Number.isInteger(next.maxEvidenceSnippets) || next.maxEvidenceSnippets < 0) {
    throw new AppError('VALIDATION', 'maxEvidenceSnippets must be a non-negative integer');
  }
  config = next;
  return config;
}

/** Reads M34_DRAFTS_PER_DAY, M34_MAX_EVIDENCE_SNIPPETS. */
export function loadDraftConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DraftConfig {
  return setDraftConfig({
    draftsPerAccountPerDay: envInt('M34_DRAFTS_PER_DAY') ?? DEFAULT_CONFIG.draftsPerAccountPerDay,
    maxEvidenceSnippets: envInt('M34_MAX_EVIDENCE_SNIPPETS') ?? DEFAULT_CONFIG.maxEvidenceSnippets,
  });
}

export function draftConfig(): DraftConfig {
  return config;
}

/** Test hook. */
export function resetDraftConfigForTesting(): void {
  config = { ...DEFAULT_CONFIG };
}
