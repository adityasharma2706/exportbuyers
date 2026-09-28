'use client';
/**
 * M31 — public removal/correction form (IF-31a `POST /api/public/removal`). No sign-in.
 * On success it shows the "check your email" message in place of the form; the actual filing
 * happens later, when the visitor clicks the emailed link (see RemovalVerify.ts).
 */
import { createElement as h, useCallback, useState, type ReactNode } from 'react';
import { Button, Card, cx } from '../../m04_ui/index.js';
import { fillLabel, type RemovalLabelKey, type RemovalLabels } from '../labels.js';
import type { RemovalKind } from '../types.js';
import { TurnstileWidget } from './TurnstileWidget.js';

export interface RemovalFormProps {
  labels: RemovalLabels;
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

interface RequestRemovalResponse {
  sent: true;
  expiresInHours: number;
}

async function postRemoval(body: unknown): Promise<RequestRemovalResponse> {
  let res: Response;
  try {
    res = await fetch('/api/public/removal', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', {});
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json && typeof json === 'object' ? (json as { error?: { code?: unknown; details?: unknown } }).error : undefined;
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    throw new ApiError(res.status, code, toRecord(err?.details));
  }
  return json as RequestRemovalResponse;
}

interface UiError {
  message: string;
}

function toUiError(e: unknown, labels: RemovalLabels): UiError {
  if (e instanceof ApiError) {
    if (e.code === 'RATE_LIMITED') {
      if (e.details.challenge === true) return { message: labels.challenge };
      const secs = typeof e.details.retryAfterSec === 'number' ? e.details.retryAfterSec : 3600;
      return { message: fillLabel(labels.rateLimited, { minutes: Math.max(1, Math.ceil(secs / 60)) }) };
    }
    if (e.code === 'VALIDATION') {
      const field = e.details.field;
      if (field === 'identifiers') return { message: labels.validationIdentifiers };
      if (field === 'details') return { message: labels.validationDetails };
      if (field === 'requesterEmail') return { message: labels.validationEmail };
    }
  }
  return { message: labels.error };
}

const inputClass = 'min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink';

function ErrorNote(props: { error: UiError | null }): ReactNode {
  if (!props.error) return null;
  return h('p', { role: 'alert', className: 'rounded-md bg-danger-50 p-3 text-sm text-danger-700' }, props.error.message);
}

interface FormState {
  kind: RemovalKind;
  requesterEmail: string;
  domain: string;
  email: string;
  phone: string;
  companyName: string;
  country: string;
  details: string;
}

const EMPTY_FORM: FormState = {
  kind: 'removal',
  requesterEmail: '',
  domain: '',
  email: '',
  phone: '',
  companyName: '',
  country: '',
  details: '',
};

function labelFor(key: RemovalLabelKey, labels: RemovalLabels): string {
  return labels[key];
}

export function RemovalForm(props: RemovalFormProps): ReactNode {
  const { labels } = props;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [result, setResult] = useState<RequestRemovalResponse | null>(null);

  const set = useCallback((key: Exclude<keyof FormState, 'kind'>) => {
    return (ev: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: ev.target.value }) as FormState);
  }, []);

  const onSubmit = useCallback(
    async (ev: { preventDefault(): void }) => {
      ev.preventDefault();
      setError(null);

      const identifiers: Record<string, string> = {};
      if (form.domain.trim()) identifiers.domain = form.domain.trim();
      if (form.email.trim()) identifiers.email = form.email.trim();
      if (form.phone.trim()) identifiers.phone = form.phone.trim();
      if (form.companyName.trim()) identifiers.companyName = form.companyName.trim();
      if (form.country.trim()) identifiers.country = form.country.trim();

      if (Object.keys(identifiers).length === 0) {
        setError({ message: labels.validationIdentifiers });
        return;
      }
      if (form.kind === 'correction' && form.details.trim().length === 0) {
        setError({ message: labels.validationDetails });
        return;
      }

      setSubmitting(true);
      try {
        const res = await postRemoval({
          requesterEmail: form.requesterEmail.trim(),
          kind: form.kind,
          identifiers,
          ...(form.details.trim() ? { details: form.details.trim() } : {}),
          turnstileToken,
        });
        setResult(res);
      } catch (e) {
        setError(toUiError(e, labels));
      } finally {
        setSubmitting(false);
      }
    },
    [form, turnstileToken, labels],
  );

  if (result) {
    return h(
      Card,
      { className: cx('flex flex-col gap-2', props.className) },
      h('p', { role: 'status', className: 'text-ink' }, fillLabel(labels.success, { ttlHours: result.expiresInHours })),
    );
  }

  return h(
    'form',
    { className: cx('flex flex-col gap-5', props.className), onSubmit: (ev: { preventDefault(): void }) => void onSubmit(ev) },
    h(
      'fieldset',
      { className: 'flex flex-col gap-2' },
      h('legend', { className: 'text-sm font-medium text-ink' }, labelFor('kindLabel', labels)),
      h(
        'div',
        { className: 'flex flex-col gap-2 sm:flex-row' },
        h(
          'label',
          { className: 'flex min-h-11 flex-1 items-center gap-2 rounded-md border border-line px-3' },
          h('input', {
            type: 'radio',
            name: 'kind',
            checked: form.kind === 'removal',
            onChange: () => setForm((f) => ({ ...f, kind: 'removal' })),
          }),
          labels.kindRemoval,
        ),
        h(
          'label',
          { className: 'flex min-h-11 flex-1 items-center gap-2 rounded-md border border-line px-3' },
          h('input', {
            type: 'radio',
            name: 'kind',
            checked: form.kind === 'correction',
            onChange: () => setForm((f) => ({ ...f, kind: 'correction' })),
          }),
          labels.kindCorrection,
        ),
      ),
    ),
    h(
      'div',
      { className: 'flex flex-col gap-1' },
      h('label', { htmlFor: 'removal-email', className: 'text-sm font-medium text-ink' }, labels.requesterEmailLabel),
      h('input', {
        id: 'removal-email',
        type: 'email',
        required: true,
        maxLength: 320,
        value: form.requesterEmail,
        onChange: set('requesterEmail'),
        className: inputClass,
      }),
      h('p', { className: 'text-sm text-ink-muted' }, labels.requesterEmailHint),
    ),
    h(
      'fieldset',
      { className: 'flex flex-col gap-3' },
      h('legend', { className: 'text-sm font-medium text-ink' }, labels.identifiersHeading),
      h('p', { className: 'text-sm text-ink-muted' }, labels.identifiersHint),
      h(
        'div',
        { className: 'grid gap-3 sm:grid-cols-2' },
        h(
          'label',
          { className: 'flex flex-col gap-1' },
          h('span', { className: 'text-sm text-ink' }, labels.domainLabel),
          h('input', { type: 'text', value: form.domain, onChange: set('domain'), maxLength: 255, className: inputClass }),
        ),
        h(
          'label',
          { className: 'flex flex-col gap-1' },
          h('span', { className: 'text-sm text-ink' }, labels.emailLabel),
          h('input', { type: 'text', value: form.email, onChange: set('email'), maxLength: 320, className: inputClass }),
        ),
        h(
          'label',
          { className: 'flex flex-col gap-1' },
          h('span', { className: 'text-sm text-ink' }, labels.phoneLabel),
          h('input', { type: 'text', value: form.phone, onChange: set('phone'), maxLength: 32, className: inputClass }),
        ),
        h(
          'label',
          { className: 'flex flex-col gap-1' },
          h('span', { className: 'text-sm text-ink' }, labels.companyNameLabel),
          h('input', { type: 'text', value: form.companyName, onChange: set('companyName'), maxLength: 300, className: inputClass }),
        ),
        h(
          'label',
          { className: 'flex flex-col gap-1' },
          h('span', { className: 'text-sm text-ink' }, labels.countryLabel),
          h('input', { type: 'text', value: form.country, onChange: set('country'), maxLength: 100, className: inputClass }),
        ),
      ),
    ),
    h(
      'div',
      { className: 'flex flex-col gap-1' },
      h('label', { htmlFor: 'removal-details', className: 'text-sm font-medium text-ink' }, labels.detailsLabel),
      h('textarea', {
        id: 'removal-details',
        value: form.details,
        onChange: set('details'),
        maxLength: 2000,
        rows: 4,
        className: cx(inputClass, 'min-h-24'),
      }),
      h('p', { className: 'text-sm text-ink-muted' }, form.kind === 'correction' ? labels.detailsHintCorrection : labels.detailsHintRemoval),
    ),
    h(TurnstileWidget, { onToken: setTurnstileToken }),
    h(ErrorNote, { error }),
    h(Button, { type: 'submit', variant: 'primary', disabled: submitting }, submitting ? labels.submitting : labels.submitButton),
  );
}
