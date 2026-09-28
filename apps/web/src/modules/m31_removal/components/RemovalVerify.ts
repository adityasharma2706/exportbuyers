'use client';
/**
 * M31 — the landing page a visitor reaches from the verification email
 * (IF-31a `GET /api/public/removal/verify?token=`). Fires the verify call once on mount and
 * shows the outcome; the actual filing happens server-side inside that call.
 */
import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import { Card, Link, ROUTES, cx } from '../../m04_ui/index.js';
import type { RemovalLabels } from '../labels.js';

export interface RemovalVerifyProps {
  labels: RemovalLabels;
  /** The `token` query parameter, already extracted server-side (may be absent/malformed). */
  token: string | null;
  className?: string;
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

interface VerifyResponse {
  filed: true;
  itemId: string;
  alreadyProcessed: boolean;
}

async function getVerify(token: string): Promise<VerifyResponse> {
  let res: Response;
  try {
    res = await fetch(`/api/public/removal/verify?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json && typeof json === 'object' ? (json as { error?: { code?: unknown } }).error : undefined;
    throw new ApiError(res.status, typeof err?.code === 'string' ? err.code : 'INTERNAL');
  }
  return json as VerifyResponse;
}

type Status = { kind: 'loading' } | { kind: 'done'; result: VerifyResponse } | { kind: 'error' };

export function RemovalVerify(props: RemovalVerifyProps): ReactNode {
  const { labels, token } = props;
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    if (!token) {
      setStatus({ kind: 'error' });
      return;
    }
    let cancelled = false;
    void getVerify(token)
      .then((result) => {
        if (!cancelled) setStatus({ kind: 'done', result });
      })
      .catch(() => {
        if (!cancelled) setStatus({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status.kind === 'loading') {
    return h(
      'div',
      { className: 'flex flex-col gap-2', 'aria-live': 'polite' },
      h(
        Card,
        { className: cx('flex flex-col gap-2', props.className) },
        h('h1', { className: 'text-xl font-semibold text-ink' }, labels.verifyingTitle),
        h('p', { className: 'text-ink-muted' }, labels.verifyingBody),
      ),
    );
  }

  if (status.kind === 'error') {
    return h(
      'div',
      { className: 'flex flex-col gap-2', 'aria-live': 'polite' },
      h(
        Card,
        { className: cx('flex flex-col gap-3', props.className) },
        h('h1', { className: 'text-xl font-semibold text-ink' }, labels.invalidTokenTitle),
        h('p', { className: 'text-ink-muted' }, labels.invalidTokenBody),
        h(Link, { href: '/removal', className: 'font-medium text-brand-700 underline' }, labels.backToForm),
      ),
    );
  }

  return h(
    'div',
    { className: 'flex flex-col gap-2', 'aria-live': 'polite' },
    h(
      Card,
      { className: cx('flex flex-col gap-3', props.className) },
      h('h1', { className: 'text-xl font-semibold text-ink' }, labels.verifiedTitle),
      h('p', { className: 'text-ink-muted' }, status.result.alreadyProcessed ? labels.alreadyProcessedBody : labels.verifiedBody),
      h(Link, { href: ROUTES.home, className: 'font-medium text-brand-700 underline' }, labels.backHome),
    ),
  );
}
