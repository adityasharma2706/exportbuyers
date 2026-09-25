/**
 * M04 — root layout (server-rendered). Sets <html lang>, provides translations to client
 * components (only the namespaces they use, to keep the JS payload small) and wraps every page in
 * the app shell.
 */
import '../globals.css';
import { createElement as h, type ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation.js';
import {
  AppShell,
  CLIENT_NAMESPACES,
  LOCALES,
  TIME_ZONE,
  isLocale,
  localeDirection,
  pickMessages,
  type Messages,
} from '../../modules/m04_ui/index.js';

interface LayoutParams {
  params: Promise<{ locale: string }>;
}

type Translate = (key: string, values?: Record<string, string>) => string;

export function generateStaticParams(): Array<{ locale: string }> {
  return LOCALES.map((locale) => ({ locale }));
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f766e',
};

export async function generateMetadata({ params }: LayoutParams): Promise<Record<string, unknown>> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t: Translate = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: { default: t('title'), template: t('titleTemplate', { page: '%s' }) },
    description: t('description'),
    formatDetection: { telephone: false },
  };
}

export default async function LocaleLayout({ children, params }: LayoutParams & { children: ReactNode }): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
    return null;
  }
  setRequestLocale(locale);

  const messages: Messages = await getMessages();

  return h(
    'html',
    { lang: locale, dir: localeDirection(locale) },
    h(
      'body',
      { className: 'antialiased' },
      h(NextIntlClientProvider, {
        locale,
        timeZone: TIME_ZONE,
        messages: pickMessages(messages, CLIENT_NAMESPACES),
        children: h(AppShell, null, children),
      }),
    ),
  );
}
