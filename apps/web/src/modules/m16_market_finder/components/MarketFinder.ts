'use client';
/**
 * M16 — Market Finder UI (REQ-010/011/012/013/014, REQ-004 anonymous try).
 *
 *   • ranked countries for the product's HS code: import value, 5-year growth, India's share,
 *     competing supplier countries, trade-agreement advantage, "why this market"
 *   • a coverage label with its explanation on every country (M04 <CoverageLabel />)
 *   • shortlist countries → saved as the workspace's default buyer-search countries (signed in) or
 *     in the anonymous session (carried over at sign-up)
 *   • no rows → guidance to try the parent 4-digit heading
 *
 * All text arrives pre-resolved in `labels` (see labels.ts) or comes from M04 components; nothing
 * here is literal UI text. The buyer-search preview and signup gate (Flow 1 step 4) belong to M26.
 */
import { createElement as h, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocale } from 'next-intl';
import { Button, Card, CoverageLabel, Disclaimer, Link, Pill, ROUTES, cx, toIntlLocale } from '../../m04_ui/index.js';
import { fillLabel, formatHsCode } from '../../m13_hs_helper/index.js';
import type { WhyFallback } from '../../m14_markets/index.js';
import type { MarketFinderLabels } from '../labels.js';
import type { CountriesSavedDto, MarketRowDto, MarketsResponse } from '../types.js';

export interface MarketFinderProps {
  labels: MarketFinderLabels;
  /** The workspace's (or anonymous visitor's) HS code; null → prompt to pick one. */
  hs: string | null;
  /** Nomenclature version of `hs`, e.g. 'ITCHS2022'. */
  version?: string | null;
  /** When set (signed-in user), the shortlist saves to this workspace; otherwise to the anonymous session. */
  workspaceId?: string | null;
  /** Currently saved default countries (pre-selected). */
  initialCountries?: readonly string[];
  /** Called after the shortlist is saved. */
  onShortlistSaved?: (saved: CountriesSavedDto) => void;
  className?: string;
}

// ---- API client -------------------------------------------------------------------------------

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

async function api<T>(path: string, method: 'GET' | 'PUT', body?: unknown): Promise<T> {
  const init: RequestInit =
    method === 'GET'
      ? { method, credentials: 'same-origin', headers: { accept: 'application/json' } }
      : {
          method,
          credentials: 'same-origin',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        };
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'NETWORK', toRecord(null));
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json && typeof json === 'object' ? (json as { error?: { code?: unknown; details?: unknown } }).error : undefined;
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    throw new ApiError(res.status, code, toRecord(err?.details));
  }
  return json as T;
}

interface UiError {
  message: string;
  signup: boolean;
}

function toUiError(e: unknown, labels: MarketFinderLabels, context: 'load' | 'save'): UiError {
  if (e instanceof ApiError) {
    if (e.code === 'RATE_LIMITED') {
      if (e.details.challenge === true) return { message: labels.challenge, signup: false };
      const secs = typeof e.details.retryAfterSec === 'number' ? e.details.retryAfterSec : 3600;
      return { message: fillLabel(labels.rateLimited, { minutes: Math.max(1, Math.ceil(secs / 60)) }), signup: true };
    }
    if (e.code === 'VALIDATION') {
      if (context === 'load') return { message: labels.invalidCode, signup: false };
      if (typeof e.details.max === 'number') return { message: labels.tooManyCountries, signup: false };
    }
    if (e.code === 'UNAUTHENTICATED' || e.code === 'SIGNUP_REQUIRED') return { message: labels.signInRequired, signup: true };
  }
  return { message: labels.error, signup: false };
}

// ---- formatting -------------------------------------------------------------------------------

interface Formatters {
  country: (iso2: string) => string;
  usd: (v: number) => string;
  pct: (fraction: number) => string;
  date: (isoDate: string) => string;
}

function makeFormatters(intlLocale: string): Formatters {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([intlLocale], { type: 'region' });
  } catch {
    names = null;
  }
  const usd = new Intl.NumberFormat(intlLocale, {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const num1 = new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 1 });
  const dateFmt = new Intl.DateTimeFormat(intlLocale, { year: 'numeric', month: 'short', timeZone: 'UTC' });
  return {
    country: (iso2) => {
      try {
        return names?.of(iso2) ?? iso2;
      } catch {
        return iso2;
      }
    },
    usd: (v) => usd.format(v),
    pct: (fraction) => num1.format(fraction * 100),
    date: (isoDate) => {
      const d = new Date(`${isoDate}T00:00:00Z`);
      return Number.isNaN(d.getTime()) ? isoDate : dateFmt.format(d);
    },
  };
}

function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The template "why" sentence from M14's numbers, used until a generated summary exists. */
export function whyFromTemplate(labels: MarketFinderLabels, fb: WhyFallback, countryName: string, intlLocale: string): string {
  const num1 = new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 1 });
  const p = fb.params;
  const parts = [
    fillLabel(labels.whyTemplate, {
      country: countryName,
      value: num1.format(p.importValueUsdMillions),
      code: formatHsCode(p.code),
      year: p.dataYear,
    }),
  ];
  if (p.cagr5yPercent !== null) parts.push(fillLabel(labels.whyTemplateGrowth, { pct: num1.format(p.cagr5yPercent) }));
  if (p.indiaSharePercent !== null) parts.push(fillLabel(labels.whyTemplateShare, { pct: num1.format(p.indiaSharePercent) }));
  return parts.join(' ');
}

// ---- presentation -----------------------------------------------------------------------------

function ErrorNote(props: { error: UiError | null; labels: MarketFinderLabels; onRetry?: (() => void) | undefined }): ReactNode {
  if (!props.error) return null;
  return h(
    'div',
    { role: 'alert', className: 'flex flex-col gap-2 rounded-md bg-danger-50 p-3 text-sm text-danger-700' },
    h('p', null, props.error.message),
    props.error.signup ? h(Link, { href: ROUTES.signUp, className: 'font-medium underline' }, props.labels.signUp) : null,
    props.onRetry ? h(Button, { variant: 'secondary', size: 'sm', onClick: props.onRetry }, props.labels.retry) : null,
  );
}

function Stat(props: { label: string; value: string }): ReactNode {
  return h(
    'div',
    { className: 'flex flex-col' },
    h('dt', { className: 'text-xs text-ink-muted' }, props.label),
    h('dd', { className: 'font-medium text-ink' }, props.value),
  );
}

interface RowCardProps {
  row: MarketRowDto;
  labels: MarketFinderLabels;
  fmt: Formatters;
  intlLocale: string;
  selected: boolean;
  onToggle: (country: string) => void;
}

function RowCard(props: RowCardProps): ReactNode {
  const { row, labels, fmt } = props;
  const name = fmt.country(row.country);
  const checkboxId = `market-shortlist-${row.country}`;
  const headingId = `market-row-${row.country}`;
  const ftaUrl = safeHttpUrl(row.fta?.sourceUrl);
  const suppliers =
    row.topSuppliers.length > 0
      ? row.topSuppliers
          .map((s) => fillLabel(labels.supplierItem, { country: fmt.country(s.country), pct: fmt.pct(s.share) }))
          .join(', ')
      : labels.suppliersNone;

  return h(
    Card,
    { as: 'li', className: cx('flex flex-col gap-3', props.selected && 'ring-2 ring-brand-600'), 'aria-labelledby': headingId },
    h(
      'div',
      { className: 'flex flex-wrap items-center gap-2' },
      h(Pill, { tone: 'info' }, fillLabel(labels.rankLabel, { rank: row.rank })),
      h('h3', { id: headingId, className: 'flex-1 text-lg font-semibold text-ink' }, name),
      h(CoverageLabel, { cell: row.coverage }),
    ),
    h(
      'dl',
      { className: 'grid grid-cols-2 gap-3 text-sm sm:grid-cols-3' },
      h(Stat, { label: labels.importValue, value: fillLabel(labels.importValueValue, { value: fmt.usd(row.importValueUsd) }) }),
      h(Stat, {
        label: labels.growth,
        value: row.cagr5y === null ? labels.growthUnknown : fillLabel(labels.growthValue, { pct: fmt.pct(row.cagr5y) }),
      }),
      h(Stat, {
        label: labels.indiaShare,
        value: row.indiaShare === null ? labels.indiaShareUnknown : fillLabel(labels.indiaShareValue, { pct: fmt.pct(row.indiaShare) }),
      }),
    ),
    h(
      'div',
      { className: 'text-sm' },
      h('p', { className: 'text-xs text-ink-muted' }, labels.suppliers),
      h('p', { className: 'text-ink' }, suppliers),
    ),
    h(
      'div',
      { className: 'flex flex-wrap items-center gap-2 text-sm' },
      h('span', { className: 'text-xs text-ink-muted' }, labels.fta),
      row.fta
        ? h(
            Pill,
            { tone: 'positive', title: row.fta.notes ?? undefined },
            fillLabel(labels.ftaValue, { agreement: row.fta.agreement, date: fmt.date(row.fta.inForceFrom) }),
          )
        : h('span', { className: 'text-ink-muted' }, labels.ftaNone),
      ftaUrl
        ? h('a', { href: ftaUrl, target: '_blank', rel: 'noopener noreferrer', className: 'text-brand-700 underline' }, labels.ftaSource)
        : null,
    ),
    h(
      'div',
      { className: 'text-sm' },
      h('p', { className: 'text-xs text-ink-muted' }, labels.why),
      h('p', { className: 'text-ink' }, row.why ?? whyFromTemplate(labels, row.whyFallback, name, props.intlLocale)),
    ),
    h(
      'label',
      { htmlFor: checkboxId, className: 'flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-ink' },
      h('input', {
        id: checkboxId,
        type: 'checkbox',
        checked: props.selected,
        onChange: () => props.onToggle(row.country),
        className: 'h-5 w-5',
      }),
      fillLabel(labels.shortlist, { country: name }),
    ),
  );
}

// ---- component --------------------------------------------------------------------------------

interface LoadState {
  loading: boolean;
  data: MarketsResponse | null;
  error: UiError | null;
}

interface SaveState {
  saving: boolean;
  message: string | null;
  error: UiError | null;
  savedAnon: boolean;
}

export function MarketFinder(props: MarketFinderProps): ReactNode {
  const { labels, workspaceId, onShortlistSaved } = props;
  const locale: string = useLocale();
  const intlLocale = toIntlLocale(locale);
  const fmt = useMemo(() => makeFormatters(intlLocale), [intlLocale]);

  const [code, setCode] = useState<string | null>(props.hs);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<LoadState>({ loading: false, data: null, error: null });
  const [selected, setSelected] = useState<string[]>(() => [...(props.initialCountries ?? [])]);
  const [save, setSave] = useState<SaveState>({ saving: false, message: null, error: null, savedAnon: false });

  useEffect(() => setCode(props.hs), [props.hs]);

  useEffect(() => {
    if (!code) {
      setLoad({ loading: false, data: null, error: null });
      return;
    }
    let cancelled = false;
    setLoad((s) => ({ ...s, loading: true, error: null }));
    const params = new URLSearchParams({ hs: code });
    // The version belongs to the saved code; a switched-to parent heading uses the default.
    if (props.version && code === props.hs) params.set('version', props.version);
    api<MarketsResponse>(`/api/markets?${params.toString()}`, 'GET')
      .then((data) => {
        if (!cancelled) setLoad({ loading: false, data, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ loading: false, data: null, error: toUiError(e, labels, 'load') });
      });
    return () => {
      cancelled = true;
    };
  }, [code, attempt, props.hs, props.version, labels]);

  const toggle = useCallback((country: string) => {
    setSelected((cur) => (cur.includes(country) ? cur.filter((c) => c !== country) : [...cur, country]));
    setSave((s) => ({ ...s, message: null, error: null }));
  }, []);

  const saveShortlist = useCallback(async () => {
    setSave({ saving: true, message: null, error: null, savedAnon: false });
    try {
      const path = workspaceId ? `/api/workspaces/${encodeURIComponent(workspaceId)}/countries` : '/api/anon/countries';
      const saved = await api<CountriesSavedDto>(path, 'PUT', { countries: selected });
      const message = workspaceId ? labels.saved : saved.persisted ? labels.savedAnon : labels.savedNotPersisted;
      setSelected(saved.countries);
      setSave({ saving: false, message, error: null, savedAnon: !workspaceId });
      onShortlistSaved?.(saved);
    } catch (e) {
      setSave({ saving: false, message: null, error: toUiError(e, labels, 'save'), savedAnon: false });
    }
  }, [workspaceId, selected, labels, onShortlistSaved]);

  if (!code) {
    return h(
      'div',
      { className: cx('flex flex-col gap-3', props.className) },
      h('p', { className: 'text-ink-muted' }, labels.noCode),
      h(Link, { href: ROUTES.products, className: 'font-medium text-brand-700 underline' }, labels.pickCode),
    );
  }

  const data = load.data;
  const shownCode = formatHsCode(data?.code ?? code);

  const header = h(
    'header',
    { className: 'flex flex-col gap-1' },
    h('h2', { className: 'text-xl font-semibold text-ink' }, fillLabel(labels.title, { code: shownCode })),
    h('p', { className: 'text-sm text-ink-muted' }, labels.intro),
    data && data.dataYear !== null ? h('p', { className: 'text-xs text-ink-muted' }, fillLabel(labels.dataYear, { year: data.dataYear })) : null,
  );

  let body: ReactNode = null;
  if (load.loading && !data) {
    body = h('p', { className: 'text-sm text-ink-muted', 'aria-live': 'polite' }, labels.loading);
  } else if (load.error) {
    body = h(ErrorNote, { error: load.error, labels, onRetry: () => setAttempt((n) => n + 1) });
  } else if (data && data.rows.length === 0) {
    const parent = data.guidance?.parentCode ?? null;
    body = h(
      'div',
      { className: 'flex flex-col gap-2' },
      h(
        'p',
        { className: 'text-ink-muted' },
        parent
          ? fillLabel(labels.noRowsTryParent, { code: shownCode, parent: formatHsCode(parent) })
          : fillLabel(labels.noRows, { code: shownCode }),
      ),
      parent
        ? h(Button, { variant: 'secondary', onClick: () => setCode(parent) }, fillLabel(labels.tryParent, { parent: formatHsCode(parent) }))
        : null,
    );
  } else if (data) {
    body = h(
      'ul',
      { className: 'flex flex-col gap-3', 'aria-busy': load.loading },
      ...data.rows.map((row) =>
        h(RowCard, {
          key: row.country,
          row,
          labels,
          fmt,
          intlLocale,
          selected: selected.includes(row.country),
          onToggle: toggle,
        }),
      ),
    );
  }

  const shortlistBar = h(
    'div',
    {
      className:
        'sticky bottom-0 flex flex-col gap-2 border-t border-line bg-surface p-3 sm:flex-row sm:items-center sm:justify-between',
      'aria-live': 'polite',
    },
    h(
      'p',
      { className: 'text-sm text-ink' },
      selected.length > 0 ? fillLabel(labels.shortlisted, { count: selected.length }) : labels.shortlistNone,
    ),
    h(
      'div',
      { className: 'flex flex-wrap gap-2' },
      h(
        Button,
        { variant: 'primary', disabled: save.saving, onClick: () => void saveShortlist() },
        save.saving ? labels.saving : labels.saveShortlist,
      ),
      save.message ? h(Link, { href: ROUTES.buyers, className: buttonLinkClass }, labels.findBuyers) : null,
    ),
  );

  return h(
    'div',
    { className: cx('flex flex-col gap-4', props.className) },
    header,
    body,
    save.message ? h('p', { role: 'status', className: 'rounded-md bg-positive-50 p-3 text-sm text-positive-700' }, save.message) : null,
    save.savedAnon
      ? h(Link, { href: ROUTES.signUp, className: 'text-sm font-medium text-brand-700 underline' }, labels.signUp)
      : null,
    h(ErrorNote, { error: save.error, labels }),
    h(Disclaimer, { kind: 'coverage' }),
    data && data.rows.length > 0 ? shortlistBar : null,
  );
}

const buttonLinkClass = 'inline-flex min-h-11 items-center rounded-md px-4 font-medium text-brand-700 underline';
