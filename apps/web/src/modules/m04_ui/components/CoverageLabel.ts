/**
 * M04 — <CoverageLabel cell /> (IF-04a). Renders M15's coverage label ("Strong" / "Partial" /
 * "Limited") with an explanation built from the cell's explanation key and params.
 *
 * The explanation uses a native <details> disclosure instead of a JS tooltip: it works on touch
 * screens, with keyboards and screen readers, and adds no client JavaScript.
 */
import { createElement as h, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toIntlLocale } from '../../../i18n/locales.js';
import type { CoverageCellDto, CoverageLabelValue } from '../dto.js';
import { isSafeKeySegment, isSafeMessageKey, splitCoverageKey } from '../wording.js';
import { cx, Icon, Pill, type PillTone } from './primitives.js';

export interface CoverageLabelProps {
  cell: CoverageCellDto;
  className?: string;
}

type Translate = ((key: string, values?: Record<string, string | number | Date>) => string) & {
  has: (key: string) => boolean;
};

const TONES: Record<CoverageLabelValue, PillTone> = {
  strong: 'positive',
  partial: 'caution',
  limited: 'neutral',
};

const FALLBACK_KEYS: Record<CoverageLabelValue, string> = {
  strong: 'coverage.strong.customs',
  partial: 'coverage.partial.few',
  limited: 'coverage.limited',
};

function listFormat(items: string[], locale: string): string {
  try {
    return new Intl.ListFormat(toIntlLocale(locale), { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** Translates source types (customs, directory, …) and joins them as a natural-language list. */
export function formatSources(t: Translate, locale: string, sources: readonly string[] | undefined): string {
  const names = (sources ?? [])
    .filter((s) => isSafeKeySegment(s))
    .map((s) => (t.has(`coverageUi.source.${s}`) ? t(`coverageUi.source.${s}`) : null))
    .filter((s): s is string => s !== null);
  return names.length > 0 ? listFormat(names, locale) : t('coverageUi.sourcesNone');
}

export function CoverageLabel(props: CoverageLabelProps): ReactNode {
  const { cell, className } = props;
  const t: Translate = useTranslations();
  const locale: string = useLocale();

  const label = TONES[cell.label] ? cell.label : 'limited';
  const labelText = t(`coverageUi.label.${label}`);
  const { key, countryLevel } = splitCoverageKey(cell.explanationKey ?? '');
  const explanationKey = isSafeMessageKey(key) && t.has(key) ? key : FALLBACK_KEYS[label];
  const count = typeof cell.params?.count === 'number' ? cell.params.count : 0;
  const explanation = t(explanationKey, { count, sources: formatSources(t, locale, cell.params?.sources) });

  return h(
    'details',
    { className: cx('group inline-block align-middle', className), 'data-coverage': label },
    h(
      'summary',
      {
        className:
          'inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-full [&::-webkit-details-marker]:hidden ' +
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600',
        'aria-label': t('coverageUi.aria', { label: labelText }),
        title: t('coverageUi.explainButton'),
      },
      h(Pill, { tone: TONES[label] }, labelText, h(Icon, { name: 'question', className: 'h-3.5 w-3.5 opacity-70' })),
    ),
    h(
      'div',
      { className: 'mt-1 max-w-xs rounded-md border border-line bg-surface p-3 text-sm text-ink shadow-md' },
      h('p', null, explanation),
      countryLevel ? h('p', { className: 'mt-1 text-ink-muted' }, t('coverageUi.countryLevel')) : null,
    ),
  );
}
