/**
 * M04 — mobile-first application shell (REQ-057). Server component: header, desktop sidebar,
 * main content and the phone bottom bar. The only client JS it pulls in is NavBar.
 *
 * `creditBalance` is a slot: M28 fills it with the live balance so it is visible on every page
 * (REQ-054). Until then the header simply omits it.
 */
import { createElement as h, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '../../../i18n/navigation.js';
import { ROUTES } from '../nav.js';
import { NavBar } from './NavBar.js';

export const MAIN_CONTENT_ID = 'main';

export interface AppShellProps {
  children?: ReactNode;
  /** Rendered in the header on every page (M28 passes the balance widget). */
  creditBalance?: ReactNode;
  /** Extra header actions, e.g. account menu from M05. */
  headerActions?: ReactNode;
}

type Translate = (key: string) => string;

export function AppShell(props: AppShellProps): ReactNode {
  const { children, creditBalance, headerActions } = props;
  const t: Translate = useTranslations();

  return h(
    'div',
    { className: 'flex min-h-dvh flex-col bg-canvas text-ink' },
    h(
      'a',
      {
        href: `#${MAIN_CONTENT_ID}`,
        className:
          'sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:p-3',
      },
      t('shell.skipToContent'),
    ),
    h(
      'header',
      { className: 'sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur' },
      h(
        'div',
        { className: 'mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4' },
        h(
          Link,
          { href: ROUTES.home, className: 'text-lg font-bold text-brand-700', 'aria-label': t('app.homeLink') },
          t('app.name'),
        ),
        h(
          'div',
          { className: 'flex items-center gap-2' },
          creditBalance
            ? h('div', { 'aria-label': t('shell.creditsLabel'), className: 'text-sm font-medium' }, creditBalance)
            : null,
          headerActions ?? null,
        ),
      ),
    ),
    h(
      'div',
      { className: 'mx-auto flex w-full max-w-6xl flex-1 gap-6 px-4' },
      h(NavBar, { variant: 'sidebar', className: 'sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-56 shrink-0 py-4 md:block' }),
      h(
        'main',
        { id: MAIN_CONTENT_ID, tabIndex: -1, className: 'min-w-0 flex-1 py-4 pb-24 md:pb-8' },
        children,
      ),
    ),
    h(
      'footer',
      { className: 'hidden border-t border-line py-4 text-center text-xs text-ink-muted md:block' },
      t('shell.footerNote'),
    ),
    h(NavBar, { variant: 'bottom', className: 'md:hidden' }),
  );
}
