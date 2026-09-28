/**
 * M31 — verification landing page (/[locale]/removal/verify?token=), reached from the
 * verification email (IF-31a `GET /api/public/removal/verify?token=`). No sign-in.
 */
import { createElement as h, type ReactNode } from 'react';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation.js';
import { isLocale, type Messages } from '../../../../modules/m04_ui/index.js';
import { RemovalVerify } from '../../../../modules/m31_removal/components/RemovalVerify.js';
import { resolveRemovalLabels } from '../../../../modules/m31_removal/labels.js';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ token?: string | string[] }>;
}

export default async function RemovalVerifyPage({ params, searchParams }: PageProps): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
    return null;
  }
  setRequestLocale(locale);
  const messages = (await getMessages()) as unknown as Messages;
  const labels = resolveRemovalLabels(messages);

  const raw = searchParams ? (await searchParams).token : undefined;
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? null;

  return h('div', { className: 'flex flex-col gap-6' }, h(RemovalVerify, { labels, token }));
}
