/**
 * M10 — identifier normalisation and hashing (IF-10c normHash). Mirrors py/kp/m10_policy/normalise.py;
 * both are checked against /spec/normalisation/vectors.json.
 *
 *   domain      lowercase; strip scheme, userinfo, path, port and a leading "www."; IDNA → punycode;
 *               reduce to the registrable domain with the pinned Public Suffix List.
 *   email       lowercase + trim (NFC). Dots and "+tags" removed only for gmail.com / googlemail.com.
 *   phone       E.164 via libphonenumber; if it cannot be parsed, "raw:" + digits only.
 *   company_id  the uuid (trimmed, lower-case).
 *   registry    "<CC>:<registry>:<ID upper-case, non-alphanumerics stripped>".
 *
 * Hash = sha256("<kind>:" + normalised), lower-case hex. No pepper (both languages must match).
 */
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { AppError } from '../m01_platform/index.js';
import { pslRules, registrableDomain } from './psl.js';
import { IDENTIFIER_KINDS, type IdentifierKind } from './types.js';

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
// eslint-disable-next-line no-control-regex
const NON_ASCII_RE = /[^\x00-\x7f]/;

export function isIdentifierKind(k: unknown): k is IdentifierKind {
  return typeof k === 'string' && (IDENTIFIER_KINDS as readonly string[]).includes(k);
}

function requireText(kind: string, raw: unknown): string {
  if (typeof raw !== 'string') throw new AppError('VALIDATION', `Cannot normalise a non-text ${kind} identifier`);
  const s = raw.trim();
  if (s === '') throw new AppError('VALIDATION', `Empty ${kind} identifier`);
  return s;
}

function toAsciiHost(host: string): string {
  if (!NON_ASCII_RE.test(host)) return host;
  const ascii = domainToASCII(host);
  return ascii !== '' ? ascii.toLowerCase() : host;
}

export function normaliseDomain(raw: string): string {
  let s = requireText('domain', raw).toLowerCase();
  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);
  else if (s.startsWith('//')) s = s.slice(2);
  s = s.split(/[/?#]/, 1)[0] ?? '';
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  if (s.startsWith('[')) {
    // IPv6 literal: keep the bracketed address, drop any port.
    const end = s.indexOf(']');
    return end > 0 ? s.slice(0, end + 1) : s;
  }
  if ((s.match(/:/g) ?? []).length === 1) s = s.slice(0, s.indexOf(':'));
  s = s.replace(/\.+$/, '');
  if (s.startsWith('www.')) s = s.slice(4);
  s = s
    .split('.')
    .filter((l) => l.length > 0)
    .join('.');
  if (s === '') throw new AppError('VALIDATION', 'Domain identifier has no host');
  if (IPV4_RE.test(s) || s.includes(':')) return s;
  s = toAsciiHost(s);
  return registrableDomain(pslRules(), s);
}

export function normaliseEmail(raw: string): string {
  const s = requireText('email', raw).normalize('NFC').toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 0) return s;
  let local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    local = (local.split('+', 1)[0] ?? '').replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

export function normalisePhone(raw: string): string {
  let s = requireText('phone', raw);
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) {
    try {
      const pn = parsePhoneNumberFromString(s);
      if (pn && pn.isPossible()) return pn.number;
    } catch {
      /* fall through to the raw form */
    }
  }
  return `raw:${digits}`;
}

export function normaliseCompanyId(raw: string): string {
  const s = requireText('company_id', raw).toLowerCase();
  if (!UUID_RE.test(s)) throw new AppError('VALIDATION', 'company_id identifiers must be uuids');
  return s;
}

export function normaliseRegistry(raw: string): string {
  const s = requireText('registry', raw);
  const first = s.indexOf(':');
  const second = first >= 0 ? s.indexOf(':', first + 1) : -1;
  if (first >= 0 && second >= 0) {
    const cc = s.slice(0, first).trim().toUpperCase();
    const reg = s.slice(first + 1, second).trim().toLowerCase();
    const id = s.slice(second + 1).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return `${cc}:${reg}:${id}`;
  }
  // Not in "<CC>:<registry>:<id>" form: keep the stripped id so M09's stored anchors still hash.
  return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function normalise(kind: IdentifierKind, raw: string): string {
  switch (kind) {
    case 'domain':
      return normaliseDomain(raw);
    case 'email':
      return normaliseEmail(raw);
    case 'phone':
      return normalisePhone(raw);
    case 'company_id':
      return normaliseCompanyId(raw);
    case 'registry':
      return normaliseRegistry(raw);
    default:
      throw new AppError('VALIDATION', `Unknown identifier kind "${String(kind)}"`);
  }
}

export function hashNormalised(kind: IdentifierKind, normalised: string): string {
  return createHash('sha256').update(`${kind}:${normalised}`, 'utf8').digest('hex');
}

/** IF-10c. sha256("<kind>:" + normalise(kind, raw)) in lower-case hex. */
export function normHash(kind: IdentifierKind, raw: string): string {
  if (!isIdentifierKind(kind)) throw new AppError('VALIDATION', `Unknown identifier kind "${String(kind)}"`);
  return hashNormalised(kind, normalise(kind, raw));
}
