/**
 * M37 — /scam-red-flags overview (REQ-031 Learn part). Public.
 */
import { createElement as h, type ReactNode } from 'react';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation.js';
import { isLocale, Link, type Messages } from '../../../modules/m04_ui/index.js';
import { ContentList, ContentPage, listBySection, getPage, resolveContentLabels } from '../../../modules/m37_content/index.js';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export default async function ScamRedFlagsIndexPage({ params }: PageProps): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
    return null;
  }
  setRequestLocale(locale);
  const messages = (await getMessages()) as unknown as Messages;
  const labels = resolveContentLabels(messages);
  const page = getPage(locale, 'scam-red-flags');
  if (!page) {
    notFound();
    return null;
  }
  const guides = listBySection(locale, 'scam-red-flags').filter((item) => item.slug !== 'index');

  return h(
    ContentPage,
    {
      page,
      labels,
      locale,
      breadcrumb: [
        { label: labels.breadcrumbHome, href: '/' },
        { label: labels.scamRedFlagsLabel, href: '/scam-red-flags' },
      ],
    },
    h(
      'section',
      { className: 'mt-4 flex flex-col gap-3' },
      h('h2', { className: 'text-lg font-semibold text-ink' }, labels.relatedGuides),
      h(ContentList, {
        items: guides,
        hrefFor: (item) => `/scam-red-flags/${item.slug}`,
        emptyLabel: labels.emptySection,
        readLabel: labels.readGuide,
      }),
      h(Link, { href: '/check', className: 'font-medium text-brand-700 hover:underline' }, labels.checkBuyerCta),
    ),
  );
}
