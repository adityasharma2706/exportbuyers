'use client';
/**
 * M04 — primary navigation (design §3.2). Client component only because it highlights the active
 * area from the current pathname; it is tiny and shares the next-intl runtime with CostBadge.
 *
 *  - variant "sidebar": every area, shown at md+ widths.
 *  - variant "bottom": fixed bottom bar on phones with four primary areas plus a "More" menu.
 */
import { createElement as h, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '../../../i18n/navigation.js';
import { activeNavId, NAV_ITEMS, partitionNav, type NavItem } from '../nav.js';
import { cx, Icon } from './primitives.js';

export interface NavBarProps {
  variant: 'sidebar' | 'bottom';
  className?: string;
}

type Translate = (key: string) => string;

function navLink(t: Translate, entry: NavItem, active: boolean, variant: NavBarProps['variant'], onNavigate?: () => void): ReactNode {
  const classes =
    variant === 'sidebar'
      ? cx(
          'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium',
          active ? 'bg-brand-50 text-brand-800' : 'text-ink hover:bg-surface-muted',
        )
      : cx(
          'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-xs font-medium',
          active ? 'text-brand-700' : 'text-ink-muted',
        );
  return h(
    Link,
    {
      key: entry.id,
      href: entry.href,
      className: classes,
      'aria-current': active ? 'page' : undefined,
      onClick: onNavigate,
    },
    h(Icon, { name: entry.icon }),
    h('span', { className: variant === 'bottom' ? 'max-w-full truncate' : undefined }, t(entry.labelKey)),
  );
}

export function NavBar(props: NavBarProps): ReactNode {
  const { variant, className } = props;
  const t: Translate = useTranslations();
  const pathname: string = usePathname() ?? '/';
  const active = activeNavId(pathname);
  const moreRef = useRef(null);

  if (variant === 'sidebar') {
    return h(
      'nav',
      { 'aria-label': t('shell.primaryNav'), className },
      h(
        'ul',
        { className: 'flex flex-col gap-1' },
        ...NAV_ITEMS.map((entry) => h('li', { key: entry.id }, navLink(t, entry, entry.id === active, 'sidebar'))),
      ),
    );
  }

  const { primary, overflow } = partitionNav(NAV_ITEMS);
  const overflowActive = overflow.some((entry) => entry.id === active);
  const closeMore = (): void => {
    const el = moreRef.current as { removeAttribute(name: string): void } | null;
    el?.removeAttribute('open');
  };

  return h(
    'nav',
    {
      'aria-label': t('shell.mobileNav'),
      className: cx(
        'fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]',
        className,
      ),
    },
    h(
      'div',
      { className: 'flex items-stretch' },
      ...primary.map((entry) => navLink(t, entry, entry.id === active, 'bottom')),
      h(
        'details',
        { ref: moreRef, className: 'relative flex flex-1' },
        h(
          'summary',
          {
            className: cx(
              'flex min-h-14 w-full cursor-pointer list-none flex-col items-center justify-center gap-0.5 px-1 text-xs font-medium',
              '[&::-webkit-details-marker]:hidden',
              overflowActive ? 'text-brand-700' : 'text-ink-muted',
            ),
            'aria-label': t('shell.moreMenu'),
          },
          h(Icon, { name: 'more' }),
          h('span', null, t('shell.more')),
        ),
        h(
          'ul',
          {
            className:
              'absolute bottom-full right-2 mb-2 w-56 rounded-lg border border-line bg-surface p-1 shadow-lg',
          },
          ...overflow.map((entry) =>
            h('li', { key: entry.id }, navLink(t, entry, entry.id === active, 'sidebar', closeMore)),
          ),
        ),
      ),
    ),
  );
}
