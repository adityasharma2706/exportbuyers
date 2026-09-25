/**
 * M04 — next-intl per-request configuration (REQ-058). Server-only.
 *
 * Missing translations never crash a page: next-intl calls onError (logged through M01's logger
 * with the key, so they show up in dashboards) and getMessageFallback renders the English text
 * when a non-English catalogue lacks a key, or the key itself as a last resort.
 */
import { getRequestConfig } from 'next-intl/server';
import { log } from '../modules/m01_platform/index.js';
import { DEFAULT_LOCALE, TIME_ZONE, getMessage, isLocale, loadMessages, type Messages } from '../modules/m04_ui/index.js';

interface IntlErrorLike {
  code?: string;
  message: string;
}

interface FallbackInfo {
  namespace?: string;
  key: string;
  error: IntlErrorLike;
}

let englishCache: Messages | null = null;

async function englishMessages(): Promise<Messages> {
  if (englishCache === null) englishCache = await loadMessages(DEFAULT_LOCALE);
  return englishCache;
}

export default getRequestConfig(async ({ requestLocale }: { requestLocale: Promise<string | undefined> }) => {
  const requested = await requestLocale;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;
  const messages = await loadMessages(locale);
  const english = locale === DEFAULT_LOCALE ? messages : await englishMessages();

  return {
    locale,
    messages,
    timeZone: TIME_ZONE,
    now: new Date(),
    onError(error: IntlErrorLike): void {
      log.warn({ locale, code: error.code, err: error.message }, 'i18n message error');
    },
    getMessageFallback({ namespace, key }: FallbackInfo): string {
      const path = namespace ? `${namespace}.${key}` : key;
      return getMessage(english, path) ?? path;
    },
  };
});
