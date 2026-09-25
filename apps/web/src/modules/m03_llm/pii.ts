/**
 * M03 — PII guard and hashing.
 *
 * The adapter never sends a user's phone number or email; callers are responsible for
 * stripping them. As a backstop, when a request is marked `piiFree: true` the prompt is
 * scanned and rejected if it contains an email or phone pattern (the flag would otherwise
 * cause the prompt to be written to logs).
 *
 * Tariff codes should be written with dots (e.g. 9403.60.1000) — dotted groups are not
 * treated as phone numbers, whereas a bare 10-digit number starting 6–9 is (Indian mobile).
 */
import { createHash } from 'node:crypto';
import { AppError } from '../m01_platform/index.js';

export type PiiKind = 'email' | 'phone';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** "+" followed by digits, spaces, dashes, dots or parentheses. Digit count is checked separately. */
const INTL_CANDIDATE_RE = /\+\s?\d[\d\s().-]{6,22}\d/g;

const PHONE_RES: readonly RegExp[] = [
  // Indian mobile, optional +91 / 91 / 0 prefix, optional single separator after 5 digits.
  /(?<![\d.])(?:(?:\+?91)[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d.])/,
  // (xxx) xxx-xxxx
  /\(\d{2,5}\)\s?\d{3,4}[\s.-]?\d{4}(?!\d)/,
  // Separated groups such as 022-2345-6789 or 555 123 4567 (dotted HS codes use 2-digit groups, so they don't match).
  /(?<![\d.])\d{3,5}[\s-]\d{3,4}[\s-]\d{4}(?![\d.])/,
];

/** Returns the kinds of personal data patterns found in `text` (never the values themselves). */
export function detectPii(text: string): PiiKind[] {
  const found = new Set<PiiKind>();
  if (EMAIL_RE.test(text)) found.add('email');
  for (const m of text.matchAll(INTL_CANDIDATE_RE)) {
    const digits = m[0].replace(/\D/g, '').length;
    if (digits >= 8 && digits <= 15) {
      found.add('phone');
      break;
    }
  }
  if (!found.has('phone') && PHONE_RES.some((re) => re.test(text))) found.add('phone');
  return [...found];
}

/** Throws VALIDATION when any of the texts contains an email or phone pattern. */
export function assertNoPii(purpose: string, texts: Iterable<string>): void {
  const kinds = new Set<PiiKind>();
  for (const t of texts) for (const k of detectPii(t)) kinds.add(k);
  if (kinds.size > 0) {
    throw new AppError('VALIDATION', 'LLM request marked piiFree contains an email or phone pattern', {
      purpose,
      kinds: [...kinds].sort(),
    });
  }
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Deterministic JSON: object keys sorted recursively, so equal values hash equally. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
