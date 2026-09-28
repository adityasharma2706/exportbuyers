/**
 * M31 — public removal/correction form page (/[locale]/removal). No sign-in (REQ-004 anonymous
 * access); reachable from the footer and from support communications.
 */
import { createElement as h, type ReactNode } from 'react';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation.js';
import { isLocale, type Messages } from '../../../modules/m04_ui/index.js';
import { RemovalForm } from '../../../modules/m31_removal/components/RemovalForm.js';
import { resolveRemovalLabels } from '../../../modules/m31_removal/labels.js';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export default async function RemovalPage({ params }: PageProps): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
    return null;
  }
  setRequestLocale(locale);
  const messages = (await getMessages()) as unknown as Messages;
  const labels = resolveRemovalLabels(messages);

  return h(
    'div',
    { className: 'flex flex-col gap-6' },
    h(
      'section',
      { className: 'flex flex-col gap-2' },
      h('h1', { className: 'text-2xl font-bold text-ink' }, labels.title),
      h('p', { className: 'text-ink-muted' }, labels.intro),
    ),
    h(RemovalForm, { labels }),
  );
}
