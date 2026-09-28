/**
 * M37 — /scam-red-flags/:slug, one red-flag guide (REQ-031 Learn part). `slug` matches
 * M32's RedFlag.guideSlug values exactly (advance-fee-scams, certification-fee-scams,
 * freemail-contacts, new-domains, name-domain-mismatch, urgent-large-orders,
 * sample-only-requests), so a link built from a CheckBuyer result always resolves. Public.
 */
import { createElement as h, type ReactNode } from 'react';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation.js';
import { isLocale, type Messages } from '../../../../modules/m04_ui/index.js';
import { ContentPage, getPage, resolveContentLabels } from '../../../../modules/m37_content/index.js';

interface PageProps {
  params: Promise<{ locale: string; slug: string }>;
}

export default async function ScamRedFlagGuidePage({ params }: PageProps): Promise<ReactNode> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) {
    notFound();
    return null;
  }
  setRequestLocale(locale);
  const messages = (await getMessages()) as unknown as Messages;
  const labels = resolveContentLabels(messages);
  const page = getPage(locale, `scam-red-flags/${slug}`);
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
      { label: labels.scamRedFlagsLabel, href: '/scam-red-flags' },
      { label: page.title, href: `/scam-red-flags/${slug}` },
    ],
  });
}
