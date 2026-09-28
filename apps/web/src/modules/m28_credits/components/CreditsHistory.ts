'use client';
/**
 * M28 — <CreditsHistory /> balance, free-allowance summary and paginated usage history
 * (REQ-054, REQ-051). Fetches its own data client-side against the routes in routes.ts, the same
 * pattern M13's HsHelper uses, so this component needs no next-intl namespace registration — its
 * labels are resolved server-side (labels.ts) and passed in as a plain prop.
 */
import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, cx, Link, ROUTES } from '../../m04_ui/index.js';
import { fillLabel, type CreditsLabels } from '../labels.js';
import type { UsageHistoryPage, UsageTxn } from '../types.js';

export interface CreditsHistoryProps {
  labels: CreditsLabels;
}

interface BalanceDto {
  available: number;
  held: number;
}

interface AllowanceDto {
  reveal: number;
  check: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) {
    const err = new Error(`http_${res.status}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

function formatNet(n: number): string {
  return n === 0 ? '0' : n > 0 ? `+${n}` : String(n);
}

function kindLabel(labels: CreditsLabels, txn: UsageTxn): string {
  const primary = txn.entries.find((e) => e.bucket === 'spent' || e.bucket === 'available') ?? txn.entries[0];
  switch (primary?.kind) {
    case 'grant':
      return labels.kindGrant;
    case 'topup':
      return labels.kindTopup;
    case 'hold':
      return labels.kindHold;
    case 'commit':
      return labels.kindCommit;
    case 'release':
      return labels.kindRelease;
    case 'refund':
      return labels.kindRefund;
    case 'expiry':
      return labels.kindExpiry;
    default:
      return labels.kindAdjustment;
  }
}

export function CreditsHistory(props: CreditsHistoryProps): ReactNode {
  const { labels } = props;
  const [balance, setBalance] = useState<BalanceDto | null>(null);
  const [allowance, setAllowance] = useState<AllowanceDto | null>(null);
  const [items, setItems] = useState<UsageTxn[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [b, a, page] = await Promise.all([
          getJson<BalanceDto>('/api/credits/balance'),
          getJson<AllowanceDto>('/api/credits/allowance'),
          getJson<UsageHistoryPage>('/api/credits/history'),
        ]);
        if (cancelled) return;
        setBalance(b);
        setAllowance(a);
        setItems(page.items);
        setCursor(page.nextCursor);
      } catch (err) {
        if (cancelled) return;
        if ((err as { status?: number }).status === 401) setSignedOut(true);
        else setError(labels.error);
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [labels.error]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    void getJson<UsageHistoryPage>(`/api/credits/history?cursor=${encodeURIComponent(cursor)}`)
      .then((page) => {
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
      })
      .catch(() => setError(labels.error))
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, labels.error]);

  if (initialLoading) {
    return h('p', { className: 'text-ink-muted', role: 'status', 'aria-live': 'polite' }, labels.loading);
  }

  if (signedOut) {
    return h(
      Card,
      { className: 'flex flex-col items-start gap-2' },
      h('p', { className: 'text-ink-muted' }, labels.signInRequired),
      h(Link, { href: ROUTES.signIn, className: 'text-brand-700 underline' }, labels.signIn),
    );
  }

  return h(
    'div',
    { className: 'flex flex-col gap-6' },
    h(
      Card,
      { className: 'flex flex-wrap gap-6' },
      h(
        'div',
        null,
        h('p', { className: 'text-sm text-ink-muted' }, labels.balanceAvailable),
        h('p', { className: 'text-2xl font-bold text-ink' }, String(balance?.available ?? 0)),
      ),
      h(
        'div',
        null,
        h('p', { className: 'text-sm text-ink-muted' }, labels.balanceHeld),
        h('p', { className: 'text-2xl font-bold text-ink' }, String(balance?.held ?? 0)),
      ),
    ),
    h(
      Card,
      { className: 'flex flex-col gap-2' },
      h('h2', { className: 'font-semibold text-ink' }, labels.allowanceHeading),
      h(
        'p',
        { className: 'text-ink-muted' },
        fillLabel((allowance?.reveal ?? 0) === 1 ? labels.allowanceRevealOne : labels.allowanceRevealOther, { count: allowance?.reveal ?? 0 }),
      ),
      h(
        'p',
        { className: 'text-ink-muted' },
        fillLabel((allowance?.check ?? 0) === 1 ? labels.allowanceCheckOne : labels.allowanceCheckOther, { count: allowance?.check ?? 0 }),
      ),
    ),
    h(
      'section',
      { className: 'flex flex-col gap-3' },
      h('h2', { className: 'font-semibold text-ink' }, labels.historyHeading),
      items.length === 0
        ? h('p', { className: 'text-ink-muted' }, labels.historyEmpty)
        : h(
            'ul',
            { className: 'flex flex-col gap-2' },
            ...items.map((txn) =>
              h(
                'li',
                { key: txn.txnId, className: 'flex items-center justify-between rounded-md border border-line px-3 py-2' },
                h('span', { className: 'text-ink' }, kindLabel(labels, txn)),
                h('span', { className: cx('font-medium', txn.netCredits < 0 ? 'text-caution-700' : 'text-ink') }, formatNet(txn.netCredits)),
              ),
            ),
          ),
      cursor ? h(Button, { variant: 'secondary', onClick: () => loadMore(), disabled: loadingMore }, loadingMore ? labels.loading : labels.loadMore) : null,
      error ? h('p', { role: 'alert', className: 'text-caution-700' }, error) : null,
    ),
  );
}
