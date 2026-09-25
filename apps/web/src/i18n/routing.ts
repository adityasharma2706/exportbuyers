/**
 * M04 — next-intl locale routing (REQ-058). Locale routing is live from day one even though only
 * English ships: the default locale has no URL prefix ('as-needed'), later locales get "/hi/...".
 */
import { defineRouting } from 'next-intl/routing';
import { DEFAULT_LOCALE, LOCALES } from './locales.js';

export const routing = defineRouting({
  locales: [...LOCALES],
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',
  // A single locale at launch: Accept-Language negotiation would only add a redirect hop on 4G.
  localeDetection: LOCALES.length > 1,
});
