/**
 * M37 — /learn overview (REQ-059, REQ-031 Learn part, REQ-044, REQ-065). Public: anonymous
 * visitors can read every Learn page.
 */
import { createElement as h, type ReactNode } from 'react';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation.js';
import { isLocale, Link, type Messages } from '../../../modules/m04_ui/index.js';
import { ContentList, listBySection, resolveContentLabels } from '../../../modules/m37_content/index.js';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export default async function LearnIndexPage({ params }: PageProps): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
    return null;
  }
  setRequestLocale(locale);
  const messages = (await getMessages()) as unknown as Messages;
  const labels = resolveContentLabels(messages);
  const items = listBySection(locale, 'learn');

  return h(
    'div',
    { className: 'flex flex-col gap-6' },
    h(
      'header',
      { className: 'flex flex-col gap-2' },
      h('h1', { className: 'text-2xl font-bold text-ink' }, labels.learnLabel),
      h('p', { className: 'text-ink-muted' }, labels.glossaryIntro),
    ),
    h(
      'nav',
      { 'aria-label': labels.onThisSection, className: 'flex flex-wrap gap-3 text-sm' },
      h(Link, { href: '/glossary', className: 'font-medium text-brand-700 hover:underline' }, labels.glossaryLabel),
      h(Link, { href: '/scam-red-flags', className: 'font-medium text-brand-700 hover:underline' }, labels.scamRedFlagsLabel),
      h(Link, { href: '/first-export-checklist', className: 'font-medium text-brand-700 hover:underline' }, labels.checklistLabel),
    ),
    h(ContentList, {
      items,
      hrefFor: (item) => `/learn/${item.slug}`,
      emptyLabel: labels.emptySection,
      readLabel: labels.readGuide,
    }),
  );
}
