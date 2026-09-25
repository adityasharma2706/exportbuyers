/**
 * M10 — Public Suffix List matching over the pinned, shared file
 * `/spec/normalisation/public_suffix_list.dat` (the Python client reads the same file).
 *
 * Algorithm (publicsuffix.org): exception rules win; otherwise the longest matching rule
 * (normal or wildcard) wins; otherwise the implicit rule "*" (the TLD alone).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, log } from '../m01_platform/index.js';

export const PSL_RELATIVE_PATH = join('spec', 'normalisation', 'public_suffix_list.dat');

export interface PslRules {
  normal: Set<string>;
  /** Parent of each "*.<parent>" rule. */
  wildcard: Set<string>;
  /** Each "!<rule>" rule, without the "!". */
  exception: Set<string>;
}

export function parsePsl(text: string): PslRules {
  const rules: PslRules = { normal: new Set(), wildcard: new Set(), exception: new Set() };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().split(/\s+/)[0] ?? '';
    if (line === '' || line.startsWith('//')) continue;
    const rule = line.toLowerCase();
    if (rule.startsWith('!')) rules.exception.add(rule.slice(1));
    else if (rule.startsWith('*.')) rules.wildcard.add(rule.slice(2));
    else rules.normal.add(rule);
  }
  return rules;
}

/** Number of labels of the public suffix of `labels` (1 when only the implicit "*" matches). */
export function publicSuffixLength(rules: PslRules, labels: readonly string[]): number {
  const n = labels.length;
  if (n === 0) return 0;
  for (let i = 0; i < n; i++) {
    if (rules.exception.has(labels.slice(i).join('.'))) return n - i - 1;
  }
  for (let i = 0; i < n; i++) {
    const cand = labels.slice(i).join('.');
    if (rules.normal.has(cand)) return n - i;
    if (i + 1 < n && rules.wildcard.has(labels.slice(i + 1).join('.'))) return n - i;
  }
  return 1;
}

/**
 * The registrable domain (public suffix + one label). A host that is itself a public suffix
 * has no registrable domain and is returned unchanged.
 */
export function registrableDomain(rules: PslRules, host: string): string {
  const labels = host.split('.').filter((l) => l.length > 0);
  if (labels.length === 0) return host;
  const suffixLen = publicSuffixLength(rules, labels);
  if (suffixLen >= labels.length) return labels.join('.');
  return labels.slice(labels.length - suffixLen - 1).join('.');
}

let loaded: PslRules | undefined;

function candidatePaths(): string[] {
  const out: string[] = [];
  const env = process.env.M10_PSL_FILE;
  if (env && env.trim()) out.push(resolve(env.trim()));
  try {
    // src/modules/m10_policy (and dist/modules/m10_policy) → repository root is five levels up.
    const here = dirname(fileURLToPath(import.meta.url));
    out.push(resolve(here, '..', '..', '..', '..', '..', PSL_RELATIVE_PATH));
  } catch {
    /* not a file URL (bundled); fall back to walking up from the cwd */
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    out.push(join(dir, PSL_RELATIVE_PATH));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/** Loads (once) and returns the pinned rules. Throws INTERNAL when the file cannot be found. */
export function pslRules(): PslRules {
  if (loaded) return loaded;
  for (const p of candidatePaths()) {
    if (existsSync(p)) {
      loaded = parsePsl(readFileSync(p, 'utf8'));
      log.info({ path: p, rules: loaded.normal.size + loaded.wildcard.size + loaded.exception.size }, 'm10 public suffix list loaded');
      return loaded;
    }
  }
  throw new AppError('INTERNAL', `Pinned public suffix list not found (${PSL_RELATIVE_PATH}); set M10_PSL_FILE`);
}

/** Test hook: install rules parsed from text (undefined → reload from disk on next use). */
export function setPslRulesForTesting(text: string | undefined): void {
  loaded = text === undefined ? undefined : parsePsl(text);
}
