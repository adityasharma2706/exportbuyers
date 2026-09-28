/**
 * M33 — tunable limits (LLD M33 API: "companyIds: string[] ≤ 200"; schema: "note.body ... ≤ 5000").
 */
export interface PipelineConfig {
  /** LLD M33 API: POST /api/workspaces/:ws/shortlist companyIds ≤ 200. */
  maxBulkAdd: number;
  /** LLD M33 schema: serving.note body length check. */
  noteMaxLength: number;
  /** GET listing page size cap [tunable]. */
  maxListLimit: number;
}

const DEFAULTS: PipelineConfig = Object.freeze({
  maxBulkAdd: 200,
  noteMaxLength: 5000,
  maxListLimit: 500,
});

let current: PipelineConfig = { ...DEFAULTS };

function positiveInt(v: string | undefined, fallback: number, max?: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return max !== undefined ? Math.min(n, max) : n;
}

export function loadPipelineConfig(env: Record<string, string | undefined> = process.env): PipelineConfig {
  current = {
    // The DB check constraint caps notes at 5000 chars, so the tunable may only lower that bound.
    maxBulkAdd: positiveInt(env.M33_MAX_BULK_ADD, DEFAULTS.maxBulkAdd, 200),
    noteMaxLength: positiveInt(env.M33_NOTE_MAX_LENGTH, DEFAULTS.noteMaxLength, 5000),
    maxListLimit: positiveInt(env.M33_MAX_LIST_LIMIT, DEFAULTS.maxListLimit),
  };
  return current;
}

export function pipelineConfig(): PipelineConfig {
  return current;
}

/** For tests. */
export function setPipelineConfig(patch: Partial<PipelineConfig>): void {
  current = { ...current, ...patch };
}
