/**
 * M04 — <Disclaimer kind /> (IF-04a). Standard notices shown next to HS suggestions, trust
 * results, sanctions results and coverage labels. Text lives in messages under `disclaimer.<kind>`.
 */
import { createElement as h, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { DisclaimerKind } from '../dto.js';
import { cx, Icon } from './primitives.js';

export const DISCLAIMER_KINDS: readonly DisclaimerKind[] = ['hs', 'trust', 'sanctions', 'coverage'];

export interface DisclaimerProps {
  kind: DisclaimerKind;
  className?: string;
}

type Translate = (key: string) => string;

export function Disclaimer(props: DisclaimerProps): ReactNode {
  const { kind, className } = props;
  const t: Translate = useTranslations('disclaimer');
  const safeKind: DisclaimerKind = DISCLAIMER_KINDS.includes(kind) ? kind : 'trust';
  return h(
    'aside',
    {
      role: 'note',
      'aria-label': t('label'),
      'data-disclaimer': safeKind,
      className: cx('flex items-start gap-2 rounded-md bg-surface-muted p-3 text-sm text-ink-muted', className),
    },
    h(Icon, { name: 'info', className: 'mt-0.5 h-4 w-4' }),
    h('p', null, t(safeKind)),
  );
}
