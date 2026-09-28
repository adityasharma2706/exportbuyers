/**
 * M40 — tunables (LLD M40, values marked [tunable]).
 */
import { AppError } from '../m01_platform/index.js';

export interface HsReconfirmConfig {
  /** Live workspaces scanned per page of the flag/silent-update pass after a nomenclature reload. [tunable] */
  scanBatchSize: number;
}

export const DEFAULT_HS_RECONFIRM_CONFIG: Readonly<HsReconfirmConfig> = Object.freeze({
  scanBatchSize: 500,
});

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new AppError('INTERNAL', `${name} must be an integer between ${min} and ${max}`, { name });
  }
  return v;
}

export function loadHsReconfirmConfig(env: NodeJS.ProcessEnv = process.env): HsReconfirmConfig {
  const d = DEFAULT_HS_RECONFIRM_CONFIG;
  return {
    scanBatchSize: int(env, 'M40_SCAN_BATCH_SIZE', d.scanBatchSize, 10, 5000),
  };
}

let current: HsReconfirmConfig | undefined;

export function hsReconfirmConfig(): HsReconfirmConfig {
  if (!current) current = loadHsReconfirmConfig();
  return current;
}

/** Replace the config (tests); undefined re-reads the environment on next use. */
export function setHsReconfirmConfig(cfg: HsReconfirmConfig | undefined): void {
  current = cfg;
}
