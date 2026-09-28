'use client';
/**
 * M32 — <CheckBuyer /> the standalone "Check a buyer" tool (REQ-030, REQ-051). Posts to
 * POST /api/check and renders the trust checklist (M04's <TrustChecklist />), the sanctions
 * result, any triggered red flags with next-step advice keys, and — when the input matched an
 * existing catalogue entity — a link to its full profile.
 */
import { createElement as h, useCallback, useState, type ReactNode } from 'react';
import { Button, Card, Link, Pill, ROUTES, TrustChecklist, cx, type TrustResultDto } from '../../m04_ui/index.js';
import { fillLabel, type CheckBuyerLabels } from '../labels.js';
import type { CheckBuyerResponseDto, RedFlag, SanctionsResultOrUnknown } from '../types.js';

export interface CheckBuyerProps {
  labels: CheckBuyerLabels;
  className?: string;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown>,
  ) {
    super(code);
  }
}

function toRecord(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = val;
  }
  return out;
}

async function postCheck(body: Record<string, string>): Promise<CheckBuyerResponseDto> {
  let res: Response;
  try {
    res = await fetch('/api/check', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', toRecord(null));
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json && typeof json === 'object' ? (json as { error?: { code?: unknown; details?: unknown } }).error : undefined;
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    throw new ApiError(res.status, code, toRecord(err?.details));
  }
  return json as CheckBuyerResponseDto;
}

interface FormState {
  name: string;
  email: string;
  website: string;
  country: string;
  messageText: string;
}

const EMPTY: FormState = { name: '', email: '', website: '', country: '', messageText: '' };

function sanctionsCopy(labels: CheckBuyerLabels, s: SanctionsResultOrUnknown): { text: string; tone: 'positive' | 'caution' | 'negative' | 'neutral' } {
  switch (s) {
    case 'clear':
      return { text: labels.sanctionsClear, tone: 'positive' };
    case 'possible':
      return { text: labels.sanctionsPossible, tone: 'caution' };
    case 'hit':
      return { text: labels.sanctionsHit, tone: 'negative' };
    default:
      return { text: labels.sanctionsUnknown, tone: 'neutral' };
  }
}

function RedFlagsList(props: { redFlags: readonly RedFlag[]; labels: CheckBuyerLabels }): ReactNode {
  const { redFlags, labels } = props;
  if (redFlags.length === 0) {
    return h('p', { className: 'text-sm text-ink-muted' }, labels.noRedFlags);
  }
  return h(
    'ul',
    { className: 'mt-2 flex flex-col gap-2' },
    ...redFlags.map((f) =>
      h(
        'li',
        { key: f.id, className: 'flex items-center justify-between gap-2 rounded-md border border-caution-200 bg-caution-50 p-2' },
        h('span', { className: 'text-sm text-caution-800' }, f.explanationKey),
        h(Pill, { tone: f.severity === 'high' ? 'negative' : 'caution' }, f.severity),
      ),
    ),
  );
}

export function CheckBuyer(props: CheckBuyerProps): ReactNode {
  const { labels, className } = props;
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckBuyerResponseDto | null>(null);

  const setField = useCallback(
    (field: keyof FormState) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [field]: e.target.value })),
    [],
  );

  const onSubmit = useCallback(
    (e: { preventDefault: () => void }) => {
      e.preventDefault();
      if (!form.name.trim() && !form.email.trim() && !form.website.trim()) {
        setError(labels.needOne);
        return;
      }
      setError(null);
      setLoading(true);
      setResult(null);
      const body: Record<string, string> = {};
      if (form.name.trim()) body.name = form.name.trim();
      if (form.email.trim()) body.email = form.email.trim();
      if (form.website.trim()) body.website = form.website.trim();
      if (form.country.trim()) body.country = form.country.trim();
      if (form.messageText.trim()) body.messageText = form.messageText.trim();
      postCheck(body)
        .then((r) => setResult(r))
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
            setError(labels.rateLimited);
          } else {
            setError(labels.error);
          }
        })
        .finally(() => setLoading(false));
    },
    [form, labels],
  );

  const trustResult: TrustResultDto | null = result ? result.trust : null;

  return h(
    'div',
    { className: cx('flex flex-col gap-4', className) },
    h(
      Card,
      { as: 'section' },
      h('h1', { className: 'text-xl font-semibold text-ink' }, labels.title),
      h('p', { className: 'mt-1 text-sm text-ink-muted' }, labels.intro),
      h(
        'form',
        { className: 'mt-4 flex flex-col gap-3', onSubmit },
        h(
          'label',
          { className: 'flex flex-col gap-1 text-sm font-medium text-ink' },
          labels.nameLabel,
          h('input', {
            className: 'min-h-11 rounded-md border border-line px-3 text-base',
            value: form.name,
            onChange: setField('name'),
            maxLength: 500,
          }),
        ),
        h(
          'label',
          { className: 'flex flex-col gap-1 text-sm font-medium text-ink' },
          labels.emailLabel,
          h('input', {
            type: 'email',
            className: 'min-h-11 rounded-md border border-line px-3 text-base',
            value: form.email,
            onChange: setField('email'),
            maxLength: 320,
          }),
        ),
        h(
          'label',
          { className: 'flex flex-col gap-1 text-sm font-medium text-ink' },
          labels.websiteLabel,
          h('input', {
            className: 'min-h-11 rounded-md border border-line px-3 text-base',
            value: form.website,
            onChange: setField('website'),
            maxLength: 2048,
          }),
        ),
        h(
          'label',
          { className: 'flex flex-col gap-1 text-sm font-medium text-ink' },
          labels.countryLabel,
          h('input', {
            className: 'min-h-11 w-24 rounded-md border border-line px-3 text-base uppercase',
            value: form.country,
            onChange: setField('country'),
            maxLength: 2,
          }),
        ),
        h(
          'label',
          { className: 'flex flex-col gap-1 text-sm font-medium text-ink' },
          labels.messageLabel,
          h('p', { className: 'text-xs text-ink-muted' }, labels.messageHelp),
          h('textarea', {
            className: 'min-h-24 rounded-md border border-line px-3 py-2 text-base',
            value: form.messageText,
            onChange: setField('messageText'),
            maxLength: 4000,
          }),
        ),
        error ? h('p', { role: 'alert', className: 'text-sm text-danger-700' }, error) : null,
        h(Button, { type: 'submit', variant: 'primary', disabled: loading }, loading ? labels.checking : labels.submit),
      ),
    ),

    result
      ? h(
          Card,
          { as: 'section', 'aria-labelledby': 'check-result-heading' },
          h('h2', { id: 'check-result-heading', className: 'text-lg font-semibold text-ink' }, labels.resultHeading),

          trustResult ? h(TrustChecklist, { result: trustResult, className: 'mt-3' }) : null,

          h(
            'div',
            { className: 'mt-3 flex items-center gap-2' },
            (() => {
              const s = sanctionsCopy(labels, result.sanctions);
              return h(Pill, { tone: s.tone }, s.text);
            })(),
          ),

          h(
            'div',
            { className: 'mt-4' },
            h('h3', { className: 'text-base font-semibold text-ink' }, labels.redFlagsHeading),
            h(RedFlagsList, { redFlags: result.redFlags, labels }),
          ),

          result.adviceKeys.length > 0
            ? h(
                'div',
                { className: 'mt-4' },
                h('h3', { className: 'text-base font-semibold text-ink' }, labels.adviceHeading),
                h(
                  'ul',
                  { className: 'mt-2 flex flex-col gap-1' },
                  ...result.adviceKeys.map((k) => h('li', { key: k, className: 'text-sm text-ink-muted' }, k)),
                ),
              )
            : null,

          result.matchedCompanyId
            ? h(
                'div',
                { className: 'mt-4 rounded-md border border-positive-200 bg-positive-50 p-3' },
                h('p', { className: 'text-sm font-medium text-positive-800' }, labels.matchedHeading),
                h('p', { className: 'mt-1 text-sm text-positive-700' }, labels.matchedBody),
                h(
                  Link,
                  { href: `${ROUTES.buyers}/${result.matchedCompanyId}`, className: 'mt-2 inline-block text-sm font-medium text-brand-700 underline' },
                  labels.viewProfile,
                ),
              )
            : null,

          result.creditsCharged > 0
            ? h('p', { className: 'mt-4 text-xs text-ink-muted' }, fillLabel(labels.costNotice, { credits: result.creditsCharged }))
            : null,
        )
      : null,

    h('p', { className: 'text-xs text-ink-muted' }, labels.disclaimer),
  );
}
