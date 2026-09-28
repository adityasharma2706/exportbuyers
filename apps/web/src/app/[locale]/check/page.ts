/**
 * M32 — "Check a buyer" page (/[locale]/check). REQ-030, REQ-051. Public: anonymous visitors may
 * use it (metered by M05's `guardAnonymous('check')`, enforced server-side by the route), signed-in
 * accounts get their monthly free allowance first, then credits.
 */
import { createElement as h, type ReactNode } from 'react';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation.js';
import { isLocale, type Messages } from '../../../modules/m04_ui/index.js';
import { CheckBuyer } from '../../../modules/m32_check_buyer/components/CheckBuyer.js';
import { resolveCheckBuyerLabels } from '../../../modules/m32_check_buyer/labels.js';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export default async function CheckBuyerPage({ params }: PageProps): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
    return null;
  }
  setRequestLocale(locale);
  const messages = (await getMessages()) as unknown as Messages;
  const labels = resolveCheckBuyerLabels(messages);

  return h('div', { className: 'flex flex-col gap-6' }, h(CheckBuyer, { labels }));
}
