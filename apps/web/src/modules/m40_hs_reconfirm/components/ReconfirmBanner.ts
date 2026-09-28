'use client';
/**
 * M40 — HS version change re-confirmation banner (REQ-009).
 *
 * Lists the signed-in account's flagged workspaces (GET /api/hs/reconfirm) and lets the user
 * either confirm one of the correlated candidates in one click (POST
 * /api/workspaces/:id/hs/reconfirm) or open M13's full HS helper to search for a fresh code
 * (which saves through M07's own POST /api/workspaces/:id/hs and also clears the flag).
 *
 * All text arrives pre-resolved in `labels` (see labels.ts); nothing here is literal UI text.
 */
import { createElement as h, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Pill, cx } from '../../m04_ui/index.js';
import { HsHelper, formatHsCode, resolveHsHelperLabels, type HsHelperLabels } from '../../m13_hs_helper/index.js';
import type { HsRelation } from '../../m12_hs/index.js';
import { fillLabel, type HsReconfirmLabelKey, type HsReconfirmLabels } from '../labels.js';
import type { ReconfirmCandidateDto, ReconfirmItemDto } from '../types.js';

export interface ReconfirmBannerProps {
  labels: HsReconfirmLabels;
  /** English fallback used by the embedded M13 HsHelper when searching for a fresh code. */
  hsHelperLabels?: HsHelperLabels;
  /** Called whenever an item is resolved (confirmed candidate or fresh save), so the caller can refresh its own workspace list. */
  onResolved?: (workspaceId: string) => void;
  className?: string;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } }
      : {
          method: 'POST',
          credentials: 'same-origin',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json && typeof json === 'object' ? (json as { error?: { code?: unknown } }).error : undefined;
    throw new ApiError(res.status, typeof err?.code === 'string' ? err.code : 'INTERNAL');
  }
  return json as T;
}

const RELATION_KEY: Record<HsRelation, HsReconfirmLabelKey> = {
  '1:1': 'relationOneToOne',
  '1:n': 'relationOneToMany',
  'n:1': 'relationManyToOne',
  'n:n': 'relationManyToMany',
};

interface ItemState {
  pendingCode: string | null;
  error: string | null;
  searching: boolean;
  resolved: boolean;
}

function ReconfirmItem(props: {
  item: ReconfirmItemDto;
  labels: HsReconfirmLabels;
  hsHelperLabels: HsHelperLabels;
  onResolved?: (workspaceId: string) => void;
}): ReactNode {
  const { item, labels, hsHelperLabels, onResolved } = props;
  const [state, setState] = useState<ItemState>({ pendingCode: null, error: null, searching: false, resolved: false });

  const confirm = useCallback(
    async (candidate: ReconfirmCandidateDto) => {
      setState((s) => ({ ...s, pendingCode: candidate.code, error: null }));
      try {
        await api(`/api/workspaces/${encodeURIComponent(item.workspaceId)}/hs/reconfirm`, { code: candidate.code });
        setState({ pendingCode: null, error: null, searching: false, resolved: true });
        onResolved?.(item.workspaceId);
      } catch {
        setState((s) => ({ ...s, pendingCode: null, error: labels.error }));
      }
    },
    [item.workspaceId, labels, onResolved],
  );

  if (state.resolved) return null;

  return h(
    Card,
    { as: 'li', className: 'flex flex-col gap-3' },
    h('div', { className: 'flex flex-wrap items-baseline gap-2' },
      h('span', { className: 'font-semibold text-ink' }, item.workspaceName),
      h('span', { className: 'text-sm text-ink-muted' }, fillLabel(labels.oldCodeLabel, { code: formatHsCode(item.oldCode) })),
    ),
    item.candidates.length > 0
      ? h(
          'div',
          { className: 'flex flex-col gap-2' },
          h('p', { className: 'text-sm font-medium text-ink' }, fillLabel(labels.possibleMatches, { newVersion: item.newVersion })),
          h(
            'ul',
            { className: 'flex flex-col gap-2' },
            ...item.candidates.map((c) =>
              h(
                'li',
                { key: c.code, className: 'flex flex-wrap items-center gap-2' },
                h('span', { className: 'font-mono text-ink' }, formatHsCode(c.code)),
                h(Pill, { tone: c.relation === '1:1' ? 'positive' : 'caution' }, labels[RELATION_KEY[c.relation]]),
                h(
                  Button,
                  {
                    variant: 'primary',
                    size: 'sm',
                    disabled: state.pendingCode !== null,
                    onClick: () => void confirm(c),
                  },
                  state.pendingCode === c.code ? labels.confirming : fillLabel(labels.confirmCode, { code: formatHsCode(c.code) }),
                ),
              ),
            ),
          ),
        )
      : h('p', { className: 'text-sm text-ink-muted' }, labels.noMatches),
    state.error ? h('p', { role: 'alert', className: 'text-sm text-danger-700' }, state.error) : null,
    h(
      Button,
      { variant: 'ghost', size: 'sm', onClick: () => setState((s) => ({ ...s, searching: !s.searching })) },
      state.searching ? labels.hideSearch : labels.searchInstead,
    ),
    state.searching
      ? h(HsHelper, {
          labels: hsHelperLabels,
          workspaceId: item.workspaceId,
          onSaved: () => {
            setState({ pendingCode: null, error: null, searching: false, resolved: true });
            onResolved?.(item.workspaceId);
          },
        })
      : null,
  );
}

export function ReconfirmBanner(props: ReconfirmBannerProps): ReactNode {
  const { labels, onResolved, className } = props;
  const hsHelperLabels = props.hsHelperLabels ?? resolveHsHelperLabels(null);
  const [items, setItems] = useState<ReconfirmItemDto[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ items: ReconfirmItemDto[] }>('/api/hs/reconfirm')
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleResolved = useCallback(
    (workspaceId: string) => {
      setItems((cur) => (cur ? cur.filter((i) => i.workspaceId !== workspaceId) : cur));
      onResolved?.(workspaceId);
    },
    [onResolved],
  );

  if (error || !items || items.length === 0) return null;

  const intro =
    items.length === 1
      ? fillLabel(labels.bannerIntroOne, { newVersion: items[0]!.newVersion })
      : fillLabel(labels.bannerIntroOther, { newVersion: items[0]!.newVersion, count: items.length });

  return h(
    'section',
    { 'aria-labelledby': 'hs-reconfirm-heading', className: cx('flex flex-col gap-3 rounded-lg border border-caution-500 bg-caution-50 p-4', className) },
    h('h2', { id: 'hs-reconfirm-heading', className: 'text-lg font-semibold text-ink' }, labels.bannerTitle),
    h('p', { className: 'text-sm text-ink' }, intro),
    h(
      'ul',
      { className: 'flex flex-col gap-3' },
      ...items.map((item) => h(ReconfirmItem, { key: item.workspaceId, item, labels, hsHelperLabels, onResolved: handleResolved })),
    ),
  );
}
