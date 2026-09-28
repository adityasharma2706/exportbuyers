/**
 * M28 — Credits & usage page (/[locale]/credits). Shows the balance, this month's free
 * allowance and the usage history (REQ-054, REQ-051). Signed-in members only; <CreditsHistory />
 * itself renders a sign-in prompt if the visitor turns out not to be signed in.
 */
import { createElement as h, type ReactNode } from 'react';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation.js';
import { isLocale, type Messages } from '../../../modules/m04_ui/index.js';
import { CreditsHistory } from '../../../modules/m28_credits/components/CreditsHistory.js';
import { resolveCreditsLabels } from '../../../modules/m28_credits/labels.js';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export default async function CreditsPage({ params }: PageProps): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
    return null;
  }
  setRequestLocale(locale);
  const messages = (await getMessages()) as unknown as Messages;
  const labels = resolveCreditsLabels(messages);

  return h(
    'div',
    { className: 'flex flex-col gap-6' },
    h(
      'section',
      { className: 'flex flex-col gap-2' },
      h('h1', { className: 'text-2xl font-bold text-ink' }, labels.title),
    ),
    h(CreditsHistory, { labels }),
  );
}
