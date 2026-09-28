/**
 * M37 — <ContentPage> renders one Markdown content page: breadcrumb, title, review/version meta
 * and the sanitised HTML body. The body comes from ContentPageDto.html, which markdown.ts already
 * escapes and allowlists (headings/paragraphs/lists/links/bold/italic/code only), so
 * dangerouslySetInnerHTML here renders trusted, operator-authored content rather than raw
 * visitor input.
 */
import { createElement as h, type ReactNode } from 'react';
import { toIntlLocale } from '../../../i18n/locales.js';
import { Link } from '../../m04_ui/index.js';
import type { ContentLabels } from '../labels.js';
import { fillLabel } from '../labels.js';
import type { ContentPageDto } from '../types.js';

export interface ContentBreadcrumbItem {
  label: string;
  href: string;
}

export interface ContentPageProps {
  page: ContentPageDto;
  labels: ContentLabels;
  locale: string;
  breadcrumb: ContentBreadcrumbItem[];
  /** Extra content rendered after the body (e.g. a "more guides" list). */
  children?: ReactNode;
}

function formatDate(locale: string, iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(toIntlLocale(locale), { dateStyle: 'medium' }).format(d);
  } catch {
    return iso;
  }
}

export function ContentPage(props: ContentPageProps): ReactNode {
  const { page, labels, locale, breadcrumb, children } = props;
  const reviewed = page.reviewedAt ? formatDate(locale, page.reviewedAt) : null;

  return h(
    'article',
    { className: 'flex flex-col gap-6' },
    h(
      'nav',
      { 'aria-label': labels.breadcrumbHome, className: 'flex flex-wrap items-center gap-1 text-sm text-ink-muted' },
      ...breadcrumb.flatMap((item, i) => {
        const isLast = i === breadcrumb.length - 1;
        const node = isLast
          ? h('span', { key: `${item.href}-label`, className: 'font-medium text-ink', 'aria-current': 'page' }, item.label)
          : h(Link, { key: item.href, href: item.href, className: 'hover:underline' }, item.label);
        return i === 0 ? [node] : [h('span', { key: `${item.href}-sep`, 'aria-hidden': true }, '/'), node];
      }),
    ),
    h(
      'header',
      { className: 'flex flex-col gap-2' },
      h('h1', { className: 'text-2xl font-bold text-ink' }, page.title),
      reviewed
        ? h('p', { className: 'text-sm text-ink-muted' }, fillLabel(labels.reviewedOn, { date: reviewed }))
        : null,
      page.localeFallback ? h('p', { className: 'text-xs text-ink-muted' }, labels.localeFallbackNote) : null,
    ),
    h('div', {
      className:
        'max-w-none text-ink leading-relaxed [&_p]:my-3 [&_a]:text-brand-700 [&_a]:underline [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-ink-muted [&_code]:rounded [&_code]:bg-surface-muted [&_code]:px-1 [&_hr]:my-6 [&_hr]:border-line',
      dangerouslySetInnerHTML: { __html: page.html },
    }),
    children ?? null,
  );
}
