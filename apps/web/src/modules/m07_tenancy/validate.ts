/**
 * M07 — pure input validation and normalisation (no I/O). All failures are VALIDATION
 * errors carrying `details.field` so the UI can point at the offending input.
 */
import { AppError } from '../m01_platform/index.js';
import { tenancyConfig } from './config.js';
import {
  EXPORT_EXPERIENCE,
  HS_LEVEL_DIGITS,
  HS_LEVELS,
  type AnonCarryOver,
  type ExportExperience,
  type HsLevel,
  type HsSelection,
  type OnboardingInput,
  type ProfilePatch,
  type WorkspaceCreateInput,
  type WorkspacePatch,
} from './types.js';

const IEC_RE = /^[A-Z0-9]{10}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const HS_VERSION_RE = /^[A-Z]{2,8}[0-9]{4}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Control characters (other than tab, LF, CR, which are collapsed) are never valid in profile text. */
const CONTROL_RE = {
  test(s: string): boolean {
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true;
    }
    return false;
  },
};

function invalid(field: string, message: string, extra?: Record<string, unknown>): AppError {
  return new AppError('VALIDATION', message, { field, ...(extra ?? {}) });
}

export function objectBody(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new AppError('VALIDATION', 'Request body must be a JSON object');
  return v as Record<string, unknown>;
}

/** Trims and collapses internal whitespace. */
function cleanText(v: string): string {
  return v.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function requiredText(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string') throw invalid(field, `${field} is required`);
  if (CONTROL_RE.test(v)) throw invalid(field, `${field} contains invalid characters`);
  const s = cleanText(v);
  if (s.length === 0) throw invalid(field, `${field} is required`);
  if (s.length > max) throw invalid(field, `${field} must be at most ${max} characters`, { max });
  return s;
}

/** undefined/null/'' → null. */
export function optionalText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw invalid(field, `${field} must be text`);
  if (CONTROL_RE.test(v)) throw invalid(field, `${field} contains invalid characters`);
  const s = cleanText(v);
  if (s.length === 0) return null;
  if (s.length > max) throw invalid(field, `${field} must be at most ${max} characters`, { max });
  return s;
}

export function parseExportExperience(v: unknown, field = 'exportExperience'): ExportExperience {
  if (typeof v === 'string' && (EXPORT_EXPERIENCE as readonly string[]).includes(v)) return v as ExportExperience;
  throw invalid(field, `${field} must be one of ${EXPORT_EXPERIENCE.join(', ')}`, { allowed: [...EXPORT_EXPERIENCE] });
}

/**
 * IEC: optional; uppercased BEFORE validation (LLD M07 rule), whitespace removed.
 * Returns null when absent or empty.
 */
export function normaliseIec(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw invalid('iec', 'IEC must be text');
  const s = v.replace(/\s+/g, '').toUpperCase();
  if (s.length === 0) return null;
  if (!IEC_RE.test(s)) throw invalid('iec', 'IEC must be 10 letters or digits');
  return s;
}

/** ISO-3166 alpha-2 list: uppercased, de-duplicated (order kept), bounded. */
export function parseCountries(v: unknown, field: string, max: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw invalid(field, `${field} must be a list of country codes`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string') throw invalid(field, `${field} must contain 2-letter country codes`);
    const c = item.trim().toUpperCase();
    if (!COUNTRY_RE.test(c)) throw invalid(field, `"${item}" is not a 2-letter country code`, { value: item });
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  if (out.length > max) throw invalid(field, `At most ${max} countries are allowed`, { max, count: out.length });
  return out;
}

export function hsLevelForCode(code: string): HsLevel | null {
  for (const level of HS_LEVELS) if (HS_LEVEL_DIGITS[level] === code.length) return level;
  return null;
}

export function parseHsSelection(v: unknown, field = 'hs'): HsSelection {
  const o = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!o) throw invalid(field, 'HS selection must be an object {code, level, version}');
  const code = typeof o.code === 'string' ? o.code.replace(/[\s.]/g, '') : '';
  if (!/^[0-9]+$/.test(code)) throw invalid(`${field}.code`, 'HS code must be digits');
  const derived = hsLevelForCode(code);
  if (!derived) throw invalid(`${field}.code`, 'HS code must have 2, 4, 6 or 8 digits');
  let level: HsLevel = derived;
  if (o.level !== undefined && o.level !== null) {
    if (typeof o.level !== 'string' || !(HS_LEVELS as readonly string[]).includes(o.level)) {
      throw invalid(`${field}.level`, `HS level must be one of ${HS_LEVELS.join(', ')}`);
    }
    level = o.level as HsLevel;
    if (HS_LEVEL_DIGITS[level] !== code.length) {
      throw invalid(`${field}.level`, `HS level ${level} needs ${HS_LEVEL_DIGITS[level]} digits`);
    }
  }
  const version = typeof o.version === 'string' ? o.version.trim().toUpperCase() : '';
  if (!HS_VERSION_RE.test(version)) throw invalid(`${field}.version`, 'HS version must look like HS2022 or ITCHS2022');
  return { code, level, version };
}

export function parseWorkspaceName(v: unknown, field = 'name'): string {
  return requiredText(v, field, tenancyConfig().workspaceNameMaxLength);
}

/** Default workspace name: `whatTheyMake`, truncated to 60 characters (LLD M07). */
export function defaultWorkspaceName(whatTheyMake: string): string {
  const max = tenancyConfig().workspaceNameMaxLength;
  const s = cleanText(whatTheyMake);
  const chars = Array.from(s); // do not split surrogate pairs
  return chars.length <= max ? s : chars.slice(0, max).join('').trimEnd();
}

function optionalEmail(v: unknown): string | null {
  const s = optionalText(v, 'senderEmail', 254);
  if (s === null) return null;
  if (!EMAIL_RE.test(s)) throw invalid('senderEmail', 'Sender email is not a valid address');
  return s.toLowerCase();
}

function optionalWebsite(v: unknown): string | null {
  const s = optionalText(v, 'website', 300);
  if (s === null) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw invalid('website', 'Website is not a valid address');
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname.includes('.')) {
    throw invalid('website', 'Website is not a valid address');
  }
  return u.toString();
}

export function parseOnboarding(body: unknown): OnboardingInput {
  const b = objectBody(body);
  return {
    businessName: requiredText(b.businessName, 'businessName', 120),
    city: optionalText(b.city, 'city', 80),
    state: optionalText(b.state, 'state', 80),
    whatTheyMake: requiredText(b.whatTheyMake, 'whatTheyMake', 300),
    exportExperience: parseExportExperience(b.exportExperience),
    iec: normaliseIec(b.iec),
    targetMarkets: parseCountries(b.targetMarkets, 'targetMarkets', tenancyConfig().maxTargetMarkets),
  };
}

const PROFILE_FIELDS = new Set([
  'businessName',
  'city',
  'state',
  'whatTheyMake',
  'exportExperience',
  'iec',
  'targetMarkets',
  'senderName',
  'senderEmail',
  'website',
]);

export function parseProfilePatch(body: unknown): ProfilePatch {
  const b = objectBody(body);
  for (const k of Object.keys(b)) {
    if (k === 'idempotencyKey') continue;
    if (!PROFILE_FIELDS.has(k)) throw invalid(k, `Unknown profile field ${k}`);
  }
  const out: ProfilePatch = {};
  if ('businessName' in b) out.businessName = requiredText(b.businessName, 'businessName', 120);
  if ('city' in b) out.city = optionalText(b.city, 'city', 80);
  if ('state' in b) out.state = optionalText(b.state, 'state', 80);
  if ('whatTheyMake' in b) out.whatTheyMake = optionalText(b.whatTheyMake, 'whatTheyMake', 300);
  if ('exportExperience' in b) out.exportExperience = b.exportExperience === null ? null : parseExportExperience(b.exportExperience);
  if ('iec' in b) out.iec = normaliseIec(b.iec);
  if ('targetMarkets' in b) out.targetMarkets = parseCountries(b.targetMarkets, 'targetMarkets', tenancyConfig().maxTargetMarkets);
  if ('senderName' in b) out.senderName = optionalText(b.senderName, 'senderName', 120);
  if ('senderEmail' in b) out.senderEmail = optionalEmail(b.senderEmail);
  if ('website' in b) out.website = optionalWebsite(b.website);
  if (Object.keys(out).length === 0) throw new AppError('VALIDATION', 'Nothing to update');
  return out;
}

export function parseWorkspaceCreate(body: unknown): WorkspaceCreateInput {
  const b = objectBody(body);
  const out: WorkspaceCreateInput = { name: parseWorkspaceName(b.name) };
  if (b.hs !== undefined && b.hs !== null) out.hs = parseHsSelection(b.hs);
  if (b.countries !== undefined) out.countries = parseCountries(b.countries, 'countries', tenancyConfig().maxCountriesPerWorkspace);
  return out;
}

export function parseWorkspacePatch(body: unknown): WorkspacePatch {
  const b = objectBody(body);
  for (const k of Object.keys(b)) {
    if (k === 'idempotencyKey') continue;
    if (k !== 'name' && k !== 'countries') throw invalid(k, `Field ${k} cannot be changed here`);
  }
  const out: WorkspacePatch = {};
  if ('name' in b) out.name = parseWorkspaceName(b.name);
  if ('countries' in b) out.countries = parseCountries(b.countries, 'countries', tenancyConfig().maxCountriesPerWorkspace);
  if (Object.keys(out).length === 0) throw new AppError('VALIDATION', 'Nothing to update');
  return out;
}

/**
 * Reads M05's anon_state_pending `{hsCode, hsVersion, countries[]}` leniently: anything that
 * does not validate is dropped rather than failing onboarding.
 */
export function parseAnonCarryOver(state: Record<string, unknown> | null): AnonCarryOver {
  if (!state) return { hs: null, countries: [] };
  let hs: HsSelection | null = null;
  if (typeof state.hsCode === 'string' && typeof state.hsVersion === 'string') {
    try {
      hs = parseHsSelection({ code: state.hsCode, version: state.hsVersion, level: state.hsLevel ?? undefined });
    } catch {
      hs = null;
    }
  }
  let countries: string[] = [];
  if (Array.isArray(state.countries)) {
    const valid = state.countries
      .filter((c): c is string => typeof c === 'string')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => COUNTRY_RE.test(c));
    countries = [...new Set(valid)].slice(0, tenancyConfig().maxCountriesPerWorkspace);
  }
  return { hs, countries };
}
