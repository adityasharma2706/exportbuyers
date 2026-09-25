/**
 * M04 — localised 404 page, rendered inside the app shell.
 */
import { createElement as h, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link, ROUTES, buttonClasses } from '../../modules/m04_ui/index.js';

type Translate = (key: string) => string;

export default function NotFound(): ReactNode {
  const t: Translate = useTranslations('common');
  return h(
    'section',
    { className: 'flex flex-col items-start gap-3 py-8' },
    h('h1', { className: 'text-2xl font-bold text-ink' }, t('notFoundTitle')),
    h('p', { className: 'text-ink-muted' }, t('notFoundBody')),
    h(Link, { href: ROUTES.home, className: buttonClasses('primary', 'md') }, t('backHome')),
  );
}
