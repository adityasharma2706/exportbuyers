/**
 * M37 — /glossary (REQ-059). Plain-English definitions of export terms. Public.
 */
import { createElement as h, type ReactNode } from 'react';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation.js';
import { isLocale, type Messages } from '../../../modules/m04_ui/index.js';
import { ContentPage, getPage, resolveContentLabels } from '../../../modules/m37_content/index.js';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export default async function GlossaryPage({ params }: PageProps): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
    return null;
  }
  setRequestLocale(locale);
  const messages = (await getMessages()) as unknown as Messages;
  const labels = resolveContentLabels(messages);
  const page = getPage(locale, 'glossary');
  if (!page) {
    notFound();
    return null;
  }

  return h(ContentPage, {
    page,
    labels,
    locale,
    breadcrumb: [
      { label: labels.breadcrumbHome, href: '/' },
      { label: labels.glossaryLabel, href: '/glossary' },
    ],
  });
}
