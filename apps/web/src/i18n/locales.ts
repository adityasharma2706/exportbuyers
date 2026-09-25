/**
 * M04 — locale configuration (REQ-058). Pure TypeScript with no framework imports, so it can be
 * used by the edge middleware, server code, client components and tests alike.
 *
 * Only English ships at launch. M51 adds 'hi' by appending it to LOCALES and adding
 * /apps/web/messages/hi.json; nothing else in the shell needs to change.
 */

export const LOCALES = ['en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** All users are in India at launch; dates render in IST regardless of the server's zone. */
export const TIME_ZONE = 'Asia/Kolkata';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Every planned Indian-language locale is left-to-right (Urdu is not planned). */
export function localeDirection(_locale: Locale): 'ltr' | 'rtl' {
  return 'ltr';
}

/**
 * BCP-47 tag used for Intl formatting. Indian region conventions apply to every locale
 * (lakh/crore digit grouping, INR currency placement).
 */
export function toIntlLocale(locale: string): string {
  const base = locale.split('-')[0] || DEFAULT_LOCALE;
  return `${base}-IN`;
}

/**
 * Removes a leading locale segment from a pathname ("/en/markets" → "/markets").
 * With `localePrefix: 'as-needed'` the default locale has no prefix, so both forms occur.
 */
export function stripLocalePrefix(pathname: string): string {
  const clean = pathname.split(/[?#]/)[0] || '/';
  const segments = clean.split('/');
  if (segments.length > 1 && isLocale(segments[1])) {
    const rest = '/' + segments.slice(2).join('/');
    return rest === '/' ? '/' : rest.replace(/\/+$/, '') || '/';
  }
  return clean.length > 1 ? clean.replace(/\/+$/, '') || '/' : '/';
}
