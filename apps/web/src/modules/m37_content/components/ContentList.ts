/**
 * M37 — <ContentList> renders a set of ContentPageSummaryDto as linkable cards (used by the
 * `/learn` and `/scam-red-flags` overview pages to list their child pages).
 */
import { createElement as h, type ReactNode } from 'react';
import { Card, Link } from '../../m04_ui/index.js';
import type { ContentPageSummaryDto } from '../types.js';

export interface ContentListProps {
  items: readonly ContentPageSummaryDto[];
  /** Builds the href for one item, e.g. (item) => `/learn/${item.slug}`. */
  hrefFor: (item: ContentPageSummaryDto) => string;
  emptyLabel: string;
  readLabel: string;
}

export function ContentList(props: ContentListProps): ReactNode {
  const { items, hrefFor, emptyLabel, readLabel } = props;
  if (items.length === 0) {
    return h('p', { className: 'text-sm text-ink-muted' }, emptyLabel);
  }
  return h(
    'ul',
    { className: 'grid gap-3 sm:grid-cols-2' },
    ...items.map((item) =>
      h(
        'li',
        { key: `${item.section}/${item.slug}` },
        h(
          Card,
          { as: 'article', className: 'flex h-full flex-col gap-2' },
          h('h3', { className: 'text-base font-semibold text-ink' }, item.title),
          h('p', { className: 'flex-1 text-sm text-ink-muted' }, item.excerpt),
          h(Link, { href: hrefFor(item), className: 'text-sm font-medium text-brand-700 hover:underline' }, readLabel),
        ),
      ),
    ),
  );
}
