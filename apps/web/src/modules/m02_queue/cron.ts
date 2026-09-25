/**
 * M02 — 5-field cron expressions, evaluated in UTC.
 *
 *   minute hour day-of-month month day-of-week
 *
 * Supports `*`, `*\/n`, `a`, `a-b`, `a-b/n`, `a/n`, comma lists, month names (JAN..DEC),
 * weekday names (SUN..SAT; 0 and 7 are both Sunday) and the macros @yearly/@annually,
 * @monthly, @weekly, @daily/@midnight and @hourly.
 *
 * Day matching follows Vixie cron: when both day-of-month and day-of-week are restricted,
 * a day matches if EITHER matches; otherwise both must match.
 *
 * The Python mirror is py/kp/m02_queue/cron.py; keep the two in step.
 */
import { AppError } from '../m01_platform/index.js';

export interface CronSpec {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>; // 1..12
  readonly daysOfWeek: ReadonlySet<number>; // 0..6, 0 = Sunday
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  nameOffset?: number;
}

const FIELDS: readonly FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  { name: 'day-of-week', min: 0, max: 7, names: DOW_NAMES, nameOffset: 0 },
];

function bad(expr: string, why: string): AppError {
  return new AppError('VALIDATION', `Invalid cron expression "${expr}": ${why}`, { cron: expr });
}

function parseValue(raw: string, f: FieldDef, expr: string): number {
  const up = raw.toUpperCase();
  if (f.names) {
    const idx = f.names.indexOf(up);
    if (idx >= 0) return idx + (f.nameOffset ?? 0);
  }
  if (!/^\d+$/.test(raw)) throw bad(expr, `"${raw}" is not a valid ${f.name} value`);
  const n = Number(raw);
  if (n < f.min || n > f.max) throw bad(expr, `${f.name} value ${n} is outside ${f.min}-${f.max}`);
  return n;
}

function parseField(text: string, f: FieldDef, expr: string): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = true;
  for (const part of text.split(',')) {
    if (part.length === 0) throw bad(expr, `empty list item in ${f.name}`);
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined || rangePart === undefined) throw bad(expr, `malformed step in ${f.name}`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw bad(expr, `step "${stepPart}" in ${f.name} must be a positive integer`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = f.min;
      hi = f.max;
      if (stepPart === undefined && text === '*') restricted = false;
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-');
      if (a === undefined || b === undefined || more !== undefined) throw bad(expr, `malformed range in ${f.name}`);
      lo = parseValue(a, f, expr);
      hi = parseValue(b, f, expr);
      if (lo > hi) throw bad(expr, `range ${a}-${b} in ${f.name} is reversed`);
    } else {
      lo = parseValue(rangePart, f, expr);
      hi = stepPart !== undefined ? f.max : lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, restricted };
}

export function parseCron(expr: string): CronSpec {
  if (typeof expr !== 'string') throw bad(String(expr), 'not a string');
  const trimmed = expr.trim();
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) throw bad(expr, `expected 5 fields, got ${parts.length}`);
  const [mi, ho, dom, mo, dow] = parts.map((p, i) => parseField(p, FIELDS[i]!, expr));
  const dowValues = new Set<number>();
  for (const d of dow!.values) dowValues.add(d === 7 ? 0 : d);
  return {
    source: trimmed,
    minutes: mi!.values,
    hours: ho!.values,
    daysOfMonth: dom!.values,
    months: mo!.values,
    daysOfWeek: dowValues,
    domRestricted: dom!.restricted,
    dowRestricted: dow!.restricted,
  };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  const domOk = spec.daysOfMonth.has(d.getUTCDate());
  const dowOk = spec.daysOfWeek.has(d.getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** True when the cron fires in the UTC minute containing `d`. */
export function cronMatches(spec: CronSpec, d: Date): boolean {
  return (
    spec.months.has(d.getUTCMonth() + 1) &&
    dayMatches(spec, d) &&
    spec.hours.has(d.getUTCHours()) &&
    spec.minutes.has(d.getUTCMinutes())
  );
}

const MINUTE_MS = 60_000;

/**
 * The latest fire time `t` with `after < t <= atOrBefore`, or null when there is none.
 * Walks backwards, skipping whole months/days/hours that cannot match.
 */
export function previousFire(spec: CronSpec, atOrBefore: Date, after: Date): Date | null {
  const floorMs = Math.floor(atOrBefore.getTime() / MINUTE_MS) * MINUTE_MS;
  const afterMs = after.getTime();
  let t = new Date(floorMs);
  // Upper bound on iterations: ~ (months + days + hours + minutes) in a multi-year window.
  for (let guard = 0; guard < 2_000_000 && t.getTime() > afterMs; guard++) {
    if (!spec.months.has(t.getUTCMonth() + 1)) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1) - MINUTE_MS);
      continue;
    }
    if (!dayMatches(spec, t)) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - MINUTE_MS);
      continue;
    }
    if (!spec.hours.has(t.getUTCHours())) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours()) - MINUTE_MS);
      continue;
    }
    if (!spec.minutes.has(t.getUTCMinutes())) {
      t = new Date(t.getTime() - MINUTE_MS);
      continue;
    }
    return t;
  }
  return null;
}

/** The earliest fire time strictly after `after` (searches up to ~5 years ahead), or null. */
export function nextFire(spec: CronSpec, after: Date): Date | null {
  let t = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  const limit = after.getTime() + 5 * 366 * 24 * 60 * MINUTE_MS;
  while (t.getTime() <= limit) {
    if (!spec.months.has(t.getUTCMonth() + 1)) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
      continue;
    }
    if (!dayMatches(spec, t)) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1));
      continue;
    }
    if (!spec.hours.has(t.getUTCHours())) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours() + 1));
      continue;
    }
    if (!spec.minutes.has(t.getUTCMinutes())) {
      t = new Date(t.getTime() + MINUTE_MS);
      continue;
    }
    return t;
  }
  return null;
}
