/**
 * M04 — <TrustChecklist result /> (IF-04a). Shows "Trust: Medium", "Checks passed: 5 of 6" and
 * one row per M24 check. Wording keys come from M37 (`trust.*`); every rendered string passes
 * through guardTrustText, so the words "verified" / "genuine" / "guaranteed" can never appear.
 */
import { createElement as h, type ReactNode } from 'react';
import { useFormatter, useTranslations, type DateTimeFormatOptions } from 'next-intl';
import type { TrustCheckDto, TrustLevel, TrustOutcome, TrustResultDto } from '../dto.js';
import { guardTrustText, isSafeKeySegment, isSafeMessageKey, orderTrustChecks, trustCounts } from '../wording.js';
import { cx, Icon, Pill, type IconName, type PillTone } from './primitives.js';

export interface TrustChecklistProps {
  result: TrustResultDto;
  className?: string;
  /** Heading level for the "Buyer checks" title, to fit the page outline. */
  headingLevel?: 2 | 3 | 4;
}

type Translate = ((key: string, values?: Record<string, string | number | Date>) => string) & {
  has: (key: string) => boolean;
};

interface Formatter {
  dateTime(value: Date, options?: DateTimeFormatOptions): string;
}

const LEVEL_TONES: Record<TrustLevel, PillTone> = {
  high: 'positive',
  medium: 'caution',
  low: 'negative',
  unknown: 'neutral',
};

const OUTCOME_ICONS: Record<TrustOutcome, IconName> = {
  pass: 'check',
  fail: 'cross',
  unknown: 'question',
};

const OUTCOME_CLASSES: Record<TrustOutcome, string> = {
  pass: 'text-positive-700',
  fail: 'text-danger-700',
  unknown: 'text-ink-muted',
};

function checkName(t: Translate, check: TrustCheckDto): string {
  const key = `trust.check.${check.id}.name`;
  return isSafeKeySegment(check.id) && t.has(key) ? t(key) : t('trust.check.other.name');
}

function checkDetail(t: Translate, check: TrustCheckDto): string {
  const outcomeText = t(`trust.outcome.${check.outcome}`);
  const explanationKey = check.explanationKey ?? '';
  const explanation =
    explanationKey && isSafeMessageKey(explanationKey) && t.has(explanationKey) ? t(explanationKey) : outcomeText;
  return guardTrustText(explanation, outcomeText);
}

function checkedOn(t: Translate, format: Formatter, check: TrustCheckDto): string {
  if (!check.checkedAt) return t('trust.notChecked');
  const date = new Date(check.checkedAt);
  if (Number.isNaN(date.getTime())) return t('trust.notChecked');
  return t('trust.checkedOn', { date: format.dateTime(date, { dateStyle: 'medium' }) });
}

export function TrustChecklist(props: TrustChecklistProps): ReactNode {
  const { result, className, headingLevel = 3 } = props;
  const t: Translate = useTranslations();
  const format: Formatter = useFormatter();

  const level: TrustLevel = LEVEL_TONES[result.level] ? result.level : 'unknown';
  const levelText = guardTrustText(t(`trust.level.${level}`), t('trust.level.unknown'));
  const { passed, total } = trustCounts(result);
  const countsText = guardTrustText(t('trust.checksPassed', { passed, total }), '');
  const checks = orderTrustChecks(result.checks);

  return h(
    'section',
    { className: cx('rounded-lg border border-line bg-surface p-4', className), 'data-trust-level': level },
    h(
      'div',
      { className: 'flex flex-wrap items-center justify-between gap-2' },
      h(`h${headingLevel}`, { className: 'text-base font-semibold text-ink' }, guardTrustText(t('trust.heading'), '')),
      h(Pill, { tone: LEVEL_TONES[level] }, levelText),
    ),
    h('p', { className: 'mt-1 text-sm text-ink-muted' }, countsText),
    h(
      'ul',
      { className: 'mt-3 divide-y divide-line' },
      ...checks.map((check) => {
        const outcome: TrustOutcome = OUTCOME_ICONS[check.outcome] ? check.outcome : 'unknown';
        return h(
          'li',
          { key: check.id, className: 'flex items-start gap-3 py-2', 'data-check': check.id, 'data-outcome': outcome },
          h(Icon, { name: OUTCOME_ICONS[outcome], className: cx('mt-0.5', OUTCOME_CLASSES[outcome]) }),
          h(
            'div',
            { className: 'min-w-0 flex-1' },
            h('p', { className: 'text-sm font-medium text-ink' }, guardTrustText(checkName(t, check), '')),
            h('p', { className: 'text-sm text-ink-muted' }, checkDetail(t, { ...check, outcome })),
            h('p', { className: 'text-xs text-ink-muted' }, checkedOn(t, format, check)),
          ),
        );
      }),
    ),
  );
}
