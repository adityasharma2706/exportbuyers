/**
 * M04 — Home route. Lists the product's main areas from the information architecture
 * (design §3.2). Later modules (M07 onwards) add dashboard content above this list.
 */
import { createElement as h, type ReactNode } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Card, Icon, Link, NAV_ITEMS, isLocale } from '../../modules/m04_ui/index.js';

interface PageProps {
  params: Promise<{ locale: string }>;
}

type Translate = (key: string) => string;

export default async function HomePage({ params }: PageProps): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
    return null;
  }
  setRequestLocale(locale);
  const t: Translate = await getTranslations();

  const areas = NAV_ITEMS.filter((entry) => entry.id !== 'home');

  return h(
    'div',
    { className: 'flex flex-col gap-6' },
    h(
      'section',
      { className: 'flex flex-col gap-2' },
      h('h1', { className: 'text-2xl font-bold text-ink' }, t('home.title')),
      h('p', { className: 'text-ink-muted' }, t('home.intro')),
    ),
    h(
      'section',
      { 'aria-labelledby': 'home-sections' },
      h('h2', { id: 'home-sections', className: 'mb-3 text-lg font-semibold text-ink' }, t('home.sectionsHeading')),
      h(
        'ul',
        { className: 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3' },
        ...areas.map((entry) =>
          h(
            Card,
            { as: 'li', key: entry.id, className: 'p-0' },
            h(
              Link,
              { href: entry.href, className: 'flex min-h-11 items-start gap-3 p-4' },
              h(Icon, { name: entry.icon, className: 'mt-0.5 text-brand-700' }),
              h(
                'span',
                { className: 'flex flex-col' },
                h('span', { className: 'font-medium text-ink' }, t(entry.labelKey)),
                h('span', { className: 'text-sm text-ink-muted' }, t(entry.descriptionKey)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
