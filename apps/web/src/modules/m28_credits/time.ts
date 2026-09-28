/**
 * M28 — IST (UTC+5:30, no DST) date helpers, used for allowance periods ('YYYY-MM' IST, LLD M28
 * schema) and the monthly free grant ("on the 1st at 00:05 IST", LLD M28 Rules).
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface IstDateParts {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
}

/** The IST calendar date/(y,m,d) containing the UTC instant `d`. */
export function istDateParts(d: Date = new Date()): IstDateParts {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1, day: ist.getUTCDate() };
}

/** 'YYYY-MM' for the IST calendar month containing `d` (ledger.allowance_usage.period format). */
export function istPeriod(d: Date = new Date()): string {
  const { year, month } = istDateParts(d);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** The UTC instant corresponding to the given IST wall-clock time. */
export function istToUtc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - IST_OFFSET_MS);
}

/** The last instant (23:59:59.999 IST) of the given IST calendar month, as a UTC Date. */
export function endOfIstMonthUtc(year: number, month: number): Date {
  const nextMonthStart = month === 12 ? istToUtc(year + 1, 1, 1) : istToUtc(year, month + 1, 1);
  return new Date(nextMonthStart.getTime() - 1);
}
