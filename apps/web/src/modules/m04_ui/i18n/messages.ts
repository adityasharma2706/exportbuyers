/**
 * M04 — message catalogue helpers (REQ-058).
 *
 * Catalogues live in /apps/web/messages/<locale>.json and are the only place user-facing text is
 * written. These helpers are framework-free so they can be used by the request config, by the
 * layout (to ship only the namespaces client components need) and by the catalogue-parity check
 * that M51 uses when it adds Hindi.
 */
import type { Locale } from '../../../i18n/locales.js';

export interface Messages {
  [key: string]: string | Messages;
}

/** Namespaces read by client components. Only these are serialised into the page payload. */
export const CLIENT_NAMESPACES = ['app', 'shell', 'nav', 'cost', 'common'] as const;

function isMessages(value: unknown): value is Messages {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Loads a locale's catalogue. The template-literal import lets the bundler emit one chunk per
 * locale, so a user only ever downloads their own language.
 */
export async function loadMessages(locale: Locale): Promise<Messages> {
  const mod: unknown = await import(`../../../../messages/${locale}.json`);
  const candidate = isMessages(mod) && 'default' in mod ? (mod as { default: unknown }).default : mod;
  if (!isMessages(candidate)) {
    throw new Error(`Message catalogue for locale "${locale}" is not an object`);
  }
  return candidate;
}

/** Flattens a nested catalogue into dot-separated keys → strings. */
export function flattenMessages(messages: Messages, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    if (key.includes('.')) {
      throw new Error(`Message key "${prefix}${key}" contains a dot; nest it instead`);
    }
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out.set(full, value);
    } else if (isMessages(value)) {
      for (const [k, v] of flattenMessages(value, full)) out.set(k, v);
    } else {
      throw new Error(`Message "${full}" must be a string or an object`);
    }
  }
  return out;
}

/** Looks up a dot-separated key. Returns undefined for a missing key or a namespace object. */
export function getMessage(messages: Messages, key: string): string | undefined {
  let node: string | Messages | undefined = messages;
  for (const part of key.split('.')) {
    if (!isMessages(node)) return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Keeps only the listed top-level namespaces (used to trim the client payload). */
export function pickMessages(messages: Messages, namespaces: readonly string[]): Messages {
  const out: Messages = {};
  for (const ns of namespaces) {
    const value = messages[ns];
    if (value !== undefined) out[ns] = value;
  }
  return out;
}

/** ICU argument names used in a message, e.g. "{count, plural, ...} of {total}" → count, total. */
export function argumentsOf(message: string): Set<string> {
  const names = new Set<string>();
  parseText(message, 0, names, false);
  return names;
}

const COMPLEX_TYPES = new Set(['plural', 'select', 'selectordinal']);

/** Parses literal text (top level or a plural/select branch). Returns the index after it. */
function parseText(src: string, start: number, names: Set<string>, inBranch: boolean): number {
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      i = parseArgument(src, i + 1, names);
    } else if (ch === '}' && inBranch) {
      return i + 1;
    } else {
      i++;
    }
  }
  return i;
}

/** Parses "{name}", "{name, number}" or "{name, plural, one {...} other {...}}" after the "{". */
function parseArgument(src: string, start: number, names: Set<string>): number {
  const head = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*([A-Za-z]+)\s*)?/.exec(src.slice(start));
  if (!head) {
    // Not an argument (malformed); skip to the matching brace.
    return skipToClose(src, start);
  }
  if (head[1]) names.add(head[1]);
  let i = start + head[0].length;
  const type = head[2];
  if (!type || !COMPLEX_TYPES.has(type)) return skipToClose(src, i);
  if (src[i] !== ',') return skipToClose(src, i);
  i++;
  // Branches: selector {text} selector {text} ... }
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i] ?? '')) i++;
    if (src[i] === '}') return i + 1;
    while (i < src.length && src[i] !== '{' && src[i] !== '}') i++;
    if (src[i] === '{') {
      i = parseText(src, i + 1, names, true);
    } else if (src[i] === '}') {
      return i + 1;
    }
  }
  return i;
}

function skipToClose(src: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return i;
}

export interface CatalogueDiff {
  /** Keys present in the base catalogue but missing from the other one. */
  missing: string[];
  /** Keys present only in the other catalogue (stale translations). */
  extra: string[];
  /** Keys whose ICU argument sets differ (a translation that drops or renames a parameter). */
  argumentMismatch: string[];
}

/** Compares a translated catalogue with the English base. M51's CI check fails on any non-empty list. */
export function diffCatalogues(base: Messages, other: Messages): CatalogueDiff {
  const a = flattenMessages(base);
  const b = flattenMessages(other);
  const missing: string[] = [];
  const extra: string[] = [];
  const argumentMismatch: string[] = [];
  for (const [key, value] of a) {
    const translated = b.get(key);
    if (translated === undefined) {
      missing.push(key);
      continue;
    }
    const pa = [...argumentsOf(value)].sort().join(',');
    const pb = [...argumentsOf(translated)].sort().join(',');
    if (pa !== pb) argumentMismatch.push(key);
  }
  for (const key of b.keys()) if (!a.has(key)) extra.push(key);
  return { missing, extra, argumentMismatch };
}
