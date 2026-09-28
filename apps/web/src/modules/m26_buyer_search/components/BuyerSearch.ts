'use client';
/**
 * M26 — Buyer search UI (REQ-015, REQ-016, REQ-018, REQ-019, REQ-020, REQ-012, REQ-024,
 * REQ-004, REQ-051).
 *
 *   • search by HS/keyword and one or more countries, defaulting to the workspace's (or
 *     anonymous session's) shortlisted countries
 *   • filters: type, recency, shipment frequency, trust, contact availability, India/competitor
 *     sourcing, and a logistics toggle
 *   • sorts: relevance, recency, volume, trust
 *   • a coverage label per country (M04 <CoverageLabel />) and a "finding more buyers…" banner
 *     that polls GET /api/buyers/discovery-status while IF-20a's on-demand job runs
 *   • anonymous preview: the count and first names, then a SignupGate (Flow 1 step 4)
 *
 * All text arrives pre-resolved in `labels` (see labels.ts) or comes from M04 components; nothing
 * here is literal UI text.
 */
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocale } from 'next-intl';
import { Button, Card, CoverageLabel, Disclaimer, Link, Pill, ROUTES, SignupGate, cx, toIntlLocale } from '../../m04_ui/index.js';
import type { CoverageCellDto } from '../../m04_ui/index.js';
import { fillLabel } from '../labels.js';
import { SIGNUP_GATE_REASON, type BuyerSearchResponseDto, type DiscoveryState, type SearchRowDto } from '../types.js';
import type { BuyerSearchLabels } from '../labels.js';

export interface BuyerSearchProps {
  labels: BuyerSearchLabels;
  /** The workspace's (or anonymous visitor's) HS code; null → prompt to pick one first. */
  hs: string | null;
  /** When set (signed-in user), the search runs against this workspace's defaults. */
  workspaceId?: string | null;
  /** Countries to offer as filter checkboxes (the workspace's or session's shortlist). */
  initialCountries?: readonly string[];
  className?: string;
}

// ---- API client (mirrors M16's MarketFinder; not shared because it is not part of any
// module's public API) -------------------------------------------------------------------------

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

async function api<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
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

function toUiError(e: unknown, labels: BuyerSearchLabels): UiError {
  if (e instanceof ApiError) {
    if (e.code === 'RATE_LIMITED') {
      if (e.details.challenge === true) return { message: labels.challenge, signup: false };
      const secs = typeof e.details.retryAfterSec === 'number' ? e.details.retryAfterSec : 3600;
      return { message: fillLabel(labels.rateLimited, { minutes: Math.max(1, Math.ceil(secs / 60)) }), signup: true };
    }
    if (e.code === 'VALIDATION' && e.details.subCode === 'NO_HS_CODE') return { message: labels.noCode, signup: false };
    if (e.code === 'VALIDATION' && e.details.field === 'countries') return { message: labels.noCountries, signup: false };
    if (e.code === 'UNAUTHENTICATED' || e.code === 'SIGNUP_REQUIRED') return { message: labels.signInRequired, signup: true };
  }
  return { message: labels.error, signup: false };
}

// ---- filter state -----------------------------------------------------------------------------

type TrustLevel = 'high' | 'medium' | 'low' | 'unknown';
const TRUST_LEVELS: readonly TrustLevel[] = ['high', 'medium', 'low', 'unknown'];
const RECENCY_OPTIONS: readonly (3 | 6 | 12)[] = [3, 6, 12];

interface Filters {
  keyword: string;
  countries: string[];
  activeWithinMonths: 3 | 6 | 12 | undefined;
  minShipments12m: number | undefined;
  trustLevels: TrustLevel[];
  originIndia: boolean;
  originCompetitor: boolean;
  includeLogistics: boolean;
  sort: 'relevance' | 'recency' | 'volume' | 'trust';
}

/** Mirrors M26's server-side `maxCountries` [tunable, default 10]: the initial selection must
 * already respect the request cap, or the very first search would fail with VALIDATION before
 * the visitor has touched a single filter. */
const MAX_COUNTRIES_UI = 10;

function initialFilters(countries: readonly string[]): Filters {
  return {
    keyword: '',
    countries: [...countries].slice(0, MAX_COUNTRIES_UI),
    activeWithinMonths: undefined,
    minShipments12m: undefined,
    trustLevels: [],
    originIndia: false,
    originCompetitor: false,
    includeLogistics: false,
    sort: 'relevance',
  };
}

function requestBody(workspaceId: string | null | undefined, filters: Filters, page: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    countries: filters.countries,
    sort: filters.sort,
    page,
    pageSize: 20,
  };
  if (workspaceId) body.workspaceId = workspaceId;
  if (filters.keyword.trim()) body.keyword = filters.keyword.trim();
  if (filters.activeWithinMonths !== undefined) body.activeWithinMonths = filters.activeWithinMonths;
  if (filters.minShipments12m !== undefined) body.minShipments12m = filters.minShipments12m;
  if (filters.trustLevels.length > 0) body.trustLevels = filters.trustLevels;
  if (filters.originIndia) body.originIndia = true;
  if (filters.originCompetitor) body.originCompetitor = true;
  if (filters.includeLogistics) body.includeLogistics = true;
  return body;
}

// ---- presentation -----------------------------------------------------------------------------

function ErrorNote(props: { error: UiError | null; labels: BuyerSearchLabels; onRetry?: (() => void) | undefined }): ReactNode {
  if (!props.error) return null;
  return h(
    'div',
    { role: 'alert', className: 'flex flex-col gap-2 rounded-md bg-danger-50 p-3 text-sm text-danger-700' },
    h('p', null, props.error.message),
    props.error.signup ? h(Link, { href: ROUTES.signUp, className: 'font-medium underline' }, props.labels.signUp) : null,
    props.onRetry ? h(Button, { variant: 'secondary', size: 'sm', onClick: props.onRetry }, props.labels.retry) : null,
  );
}

const TRUST_TONE: Record<string, 'positive' | 'info' | 'caution' | 'neutral'> = {
  high: 'positive',
  medium: 'info',
  low: 'caution',
  unknown: 'neutral',
};

function trustLabel(labels: BuyerSearchLabels, level: string): string {
  switch (level) {
    case 'high':
      return labels.trustHigh;
    case 'medium':
      return labels.trustMedium;
    case 'low':
      return labels.trustLow;
    default:
      return labels.trustUnknown;
  }
}

function dateFmt(intlLocale: string): (isoDate: string) => string {
  const fmt = new Intl.DateTimeFormat(intlLocale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (isoDate) => {
    const d = new Date(isoDate);
    return Number.isNaN(d.getTime()) ? isoDate : fmt.format(d);
  };
}

function RowCard(props: { row: SearchRowDto; labels: BuyerSearchLabels; formatDate: (d: string) => string }): ReactNode {
  const { row, labels, formatDate } = props;
  const headingId = `buyer-row-${row.companyId || row.name}`;
  const href = row.companyId ? `${ROUTES.buyers}/${encodeURIComponent(row.companyId)}` : undefined;
  return h(
    Card,
    { as: 'li', 'aria-labelledby': headingId, className: 'flex flex-col gap-2' },
    h(
      'div',
      { className: 'flex flex-wrap items-center gap-2' },
      href
        ? h(Link, { href, id: headingId, className: 'text-lg font-semibold text-brand-700 underline' }, row.name)
        : h('h3', { id: headingId, className: 'text-lg font-semibold text-ink' }, row.name),
      h(Pill, { tone: TRUST_TONE[row.trustLevel] ?? 'neutral' }, trustLabel(labels, row.trustLevel)),
      row.lowConfidence ? h(Pill, { tone: 'caution' }, labels.lowConfidence) : null,
      row.sanctionsWarning ? h(Pill, { tone: 'negative' }, labels.sanctionsWarning) : null,
    ),
    h(
      'p',
      { className: 'text-sm text-ink-muted' },
      [row.city, row.country].filter(Boolean).join(', '),
      row.buyerType ? ` · ${row.buyerType}` : '',
    ),
    h(
      'p',
      { className: 'text-sm text-ink' },
      row.lastActivity ? fillLabel(labels.lastActivity, { date: formatDate(row.lastActivity) }) : labels.lastActivityUnknown,
    ),
    row.evidenceSummary.length > 0
      ? h(
          'div',
          { className: 'text-sm' },
          h('p', { className: 'text-xs text-ink-muted' }, labels.evidenceHeading),
          h(
            'ul',
            { className: 'list-inside list-disc text-ink' },
            ...row.evidenceSummary.slice(0, 2).map((e, i) => h('li', { key: i }, e.snippet ?? e.sourceType)),
          ),
        )
      : null,
    h(
      'div',
      { className: 'flex flex-wrap gap-1' },
      row.contactTypes.length > 0
        ? row.contactTypes.map((k) => h(Pill, { key: k, tone: 'neutral' }, k))
        : h('span', { className: 'text-sm text-ink-muted' }, labels.contactTypesNone),
    ),
  );
}

function CheckboxGroup<T extends string>(props: {
  legend: string;
  name: string;
  options: readonly T[];
  labelFor: (v: T) => string;
  selected: readonly T[];
  onToggle: (v: T) => void;
}): ReactNode {
  return h(
    'fieldset',
    { className: 'flex flex-col gap-1' },
    h('legend', { className: 'text-sm font-medium text-ink' }, props.legend),
    h(
      'div',
      { className: 'flex flex-wrap gap-3' },
      ...props.options.map((opt) => {
        const id = `${props.name}-${opt}`;
        return h(
          'label',
          { key: opt, htmlFor: id, className: 'flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink' },
          h('input', {
            id,
            type: 'checkbox',
            checked: props.selected.includes(opt),
            onChange: () => props.onToggle(opt),
            className: 'h-5 w-5',
          }),
          props.labelFor(opt),
        );
      }),
    ),
  );
}

// ---- component --------------------------------------------------------------------------------

interface LoadState {
  loading: boolean;
  data: BuyerSearchResponseDto | null;
  error: UiError | null;
}

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_MS = 180_000;

export function BuyerSearch(props: BuyerSearchProps): ReactNode {
  const { labels, hs, workspaceId } = props;
  const locale: string = useLocale();
  const intlLocale = toIntlLocale(locale);
  const formatDate = useMemo(() => dateFmt(intlLocale), [intlLocale]);

  const shortlist = useMemo(() => [...(props.initialCountries ?? [])], [props.initialCountries]);
  const [filters, setFilters] = useState<Filters>(() => initialFilters(shortlist));
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<LoadState>({ loading: false, data: null, error: null });

  useEffect(() => setFilters(initialFilters(shortlist)), [shortlist]);

  useEffect(() => {
    if (!hs || filters.countries.length === 0) {
      setLoad({ loading: false, data: null, error: null });
      return;
    }
    let cancelled = false;
    setLoad((s) => ({ ...s, loading: true, error: null }));
    api<BuyerSearchResponseDto>('/api/buyers/search', 'POST', requestBody(workspaceId, filters, page))
      .then((data) => {
        if (!cancelled) setLoad({ loading: false, data, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ loading: false, data: null, error: toUiError(e, labels) });
      });
    return () => {
      cancelled = true;
    };
    // filters is a plain object rebuilt on every change through setFilters, so it is a safe dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hs, workspaceId, filters, page, attempt, labels]);

  // "Finding more buyers…" polling (LLD: every 5 s, for at most 3 minutes).
  const [discovery, setDiscovery] = useState<Record<string, DiscoveryState>>({});
  const pollStart = useRef<number>(0);
  useEffect(() => {
    setDiscovery(load.data?.discovery ?? {});
    pollStart.current = Date.now();
  }, [load.data]);

  useEffect(() => {
    const heading = hs ? hs.slice(0, 4) : null;
    const countries = Object.entries(discovery)
      .filter(([, s]) => s === 'running')
      .map(([c]) => c);
    if (!heading || countries.length === 0) return;
    const timer = setInterval(() => {
      if (Date.now() - pollStart.current > POLL_MAX_MS) {
        clearInterval(timer);
        return;
      }
      const params = new URLSearchParams({ heading, countries: countries.join(',') });
      api<Record<string, DiscoveryState>>(`/api/buyers/discovery-status?${params.toString()}`, 'GET')
        .then((next) => setDiscovery((cur) => ({ ...cur, ...next })))
        .catch(() => {
          /* transient poll failure: keep the current banner and try again next tick */
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [discovery, hs]);

  const toggleCountry = useCallback((c: string) => {
    setFilters((f) => {
      if (f.countries.includes(c)) return { ...f, countries: f.countries.filter((x) => x !== c) };
      if (f.countries.length >= MAX_COUNTRIES_UI) return f; // LLD M26 rule: at most 10 countries per search.
      return { ...f, countries: [...f.countries, c] };
    });
    setPage(1);
  }, []);
  const toggleTrust = useCallback((t: TrustLevel) => {
    setFilters((f) => ({ ...f, trustLevels: f.trustLevels.includes(t) ? f.trustLevels.filter((x) => x !== t) : [...f.trustLevels, t] }));
    setPage(1);
  }, []);
  const submit = useCallback((e: { preventDefault: () => void }) => {
    e.preventDefault();
    setPage(1);
    setAttempt((n) => n + 1);
  }, []);

  if (!hs) {
    return h(
      'div',
      { className: cx('flex flex-col gap-3', props.className) },
      h('p', { className: 'text-ink-muted' }, labels.noCode),
      h(Link, { href: ROUTES.products, className: 'font-medium text-brand-700 underline' }, labels.pickCode),
    );
  }
  if (shortlist.length === 0) {
    return h(
      'div',
      { className: cx('flex flex-col gap-3', props.className) },
      h('p', { className: 'text-ink-muted' }, labels.noCountries),
      h(Link, { href: ROUTES.markets, className: 'font-medium text-brand-700 underline' }, labels.pickCountries),
    );
  }

  const data = load.data;
  const runningCountries = Object.entries(discovery).filter(([, s]) => s === 'running');

  const filterPanel = h(
    'form',
    { className: 'flex flex-col gap-4 rounded-lg border border-line bg-surface p-4', onSubmit: submit },
    h('h2', { className: 'text-lg font-semibold text-ink' }, labels.filtersHeading),
    h(
      'label',
      { className: 'flex flex-col gap-1 text-sm font-medium text-ink' },
      labels.keywordLabel,
      h('input', {
        type: 'text',
        value: filters.keyword,
        'aria-describedby': 'buyer-search-keyword-hint',
        onChange: (e: { target: { value: string } }) => setFilters((f) => ({ ...f, keyword: e.target.value })),
        className: 'min-h-11 rounded-md border border-line px-3 text-base text-ink',
        maxLength: 100,
      }),
      h('span', { id: 'buyer-search-keyword-hint', className: 'text-xs text-ink-muted' }, labels.keywordHint),
    ),
    CheckboxGroup({
      legend: labels.filterCountries,
      name: 'country',
      options: shortlist,
      labelFor: (c: string) => c,
      selected: filters.countries,
      onToggle: toggleCountry,
    }),
    h(
      'label',
      { className: 'flex flex-col gap-1 text-sm font-medium text-ink' },
      labels.filterRecency,
      h(
        'select',
        {
          value: filters.activeWithinMonths ?? '',
          onChange: (e: { target: { value: string } }) =>
            setFilters((f) => ({ ...f, activeWithinMonths: e.target.value ? (Number(e.target.value) as 3 | 6 | 12) : undefined })),
          className: 'min-h-11 rounded-md border border-line px-3 text-base text-ink',
        },
        h('option', { value: '' }, labels.filterRecencyAny),
        ...RECENCY_OPTIONS.map((m) =>
          h('option', { key: m, value: m }, m === 3 ? labels.filterRecency3 : m === 6 ? labels.filterRecency6 : labels.filterRecency12),
        ),
      ),
    ),
    h(
      'label',
      { className: 'flex flex-col gap-1 text-sm font-medium text-ink' },
      labels.filterMinShipments,
      h('input', {
        type: 'number',
        min: 0,
        value: filters.minShipments12m ?? '',
        onChange: (e: { target: { value: string } }) =>
          setFilters((f) => ({ ...f, minShipments12m: e.target.value ? Number(e.target.value) : undefined })),
        className: 'min-h-11 w-32 rounded-md border border-line px-3 text-base text-ink',
      }),
    ),
    CheckboxGroup({
      legend: labels.filterTrust,
      name: 'trust',
      options: TRUST_LEVELS,
      labelFor: (t: TrustLevel) => trustLabel(labels, t),
      selected: filters.trustLevels,
      onToggle: toggleTrust,
    }),
    h(
      'div',
      { className: 'flex flex-col gap-2' },
      h(
        'label',
        { className: 'flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink' },
        h('input', {
          type: 'checkbox',
          checked: filters.originIndia,
          onChange: () => setFilters((f) => ({ ...f, originIndia: !f.originIndia })),
          className: 'h-5 w-5',
        }),
        labels.filterOriginIndia,
      ),
      h(
        'label',
        { className: 'flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink' },
        h('input', {
          type: 'checkbox',
          checked: filters.originCompetitor,
          onChange: () => setFilters((f) => ({ ...f, originCompetitor: !f.originCompetitor })),
          className: 'h-5 w-5',
        }),
        labels.filterOriginCompetitor,
      ),
      h(
        'label',
        { className: 'flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink' },
        h('input', {
          type: 'checkbox',
          checked: filters.includeLogistics,
          onChange: () => setFilters((f) => ({ ...f, includeLogistics: !f.includeLogistics })),
          className: 'h-5 w-5',
        }),
        labels.filterLogistics,
      ),
    ),
    h(
      'label',
      { className: 'flex flex-col gap-1 text-sm font-medium text-ink' },
      labels.sortLabel,
      h(
        'select',
        {
          value: filters.sort,
          onChange: (e: { target: { value: string } }) => setFilters((f) => ({ ...f, sort: e.target.value as Filters['sort'] })),
          className: 'min-h-11 rounded-md border border-line px-3 text-base text-ink',
        },
        h('option', { value: 'relevance' }, labels.sortRelevance),
        h('option', { value: 'recency' }, labels.sortRecency),
        h('option', { value: 'volume' }, labels.sortVolume),
        h('option', { value: 'trust' }, labels.sortTrust),
      ),
    ),
    h(Button, { type: 'submit', variant: 'primary' }, load.loading ? labels.searching : labels.searchButton),
  );

  const coverageBar = data
    ? h(
        'div',
        { className: 'flex flex-wrap items-center gap-3', 'aria-live': 'polite' },
        ...Object.entries(data.coverage).map(([country, cell]: [string, CoverageCellDto]) =>
          h(
            'span',
            { key: country, className: 'inline-flex items-center gap-1 text-sm' },
            h('span', { className: 'text-ink' }, country),
            h(CoverageLabel, { cell }),
          ),
        ),
      )
    : null;

  const findingMore =
    runningCountries.length > 0
      ? h(
          'div',
          { role: 'status', 'aria-live': 'polite', className: 'flex flex-col gap-1 rounded-md bg-brand-50 p-3 text-sm text-brand-700' },
          ...runningCountries.map(([country]) => h('p', { key: country }, fillLabel(labels.findingMore, { country }))),
        )
      : null;

  let body: ReactNode = null;
  if (load.loading && !data) {
    body = h('p', { className: 'text-sm text-ink-muted', 'aria-live': 'polite' }, labels.loading);
  } else if (load.error) {
    body = h(ErrorNote, { error: load.error, labels, onRetry: () => setAttempt((n) => n + 1) });
  } else if (data && data.previewMode) {
    const names = data.rows.map((r) => r.name).filter(Boolean);
    body = h(
      'div',
      { className: 'flex flex-col gap-3' },
      h('p', { className: 'text-ink' }, fillLabel(labels.previewCount, { count: data.total })),
      names.length > 0 ? h('p', { className: 'text-ink-muted' }, fillLabel(labels.previewNames, { names: names.join(', ') })) : null,
      h('p', { className: 'text-ink-muted' }, labels.previewNote),
      h(SignupGate, { reason: SIGNUP_GATE_REASON }),
    );
  } else if (data && data.rows.length === 0) {
    body = h('p', { className: 'text-ink-muted' }, labels.noResults);
  } else if (data) {
    body = h(
      'div',
      { className: 'flex flex-col gap-4' },
      h(
        'h2',
        { className: 'text-lg font-semibold text-ink', 'aria-live': 'polite' },
        data.shown === 1 ? labels.resultsHeadingOne : fillLabel(labels.resultsHeading, { count: data.shown }),
      ),
      data.limit ? h('p', { className: 'text-sm text-ink-muted' }, fillLabel(labels.planLimit, { shown: data.shown, total: data.total })) : null,
      h(
        'ul',
        { className: 'flex flex-col gap-3', 'aria-busy': load.loading },
        ...data.rows.map((row) => h(RowCard, { key: row.companyId || row.name, row, labels, formatDate })),
      ),
      h(
        'div',
        { className: 'flex items-center justify-between' },
        h(
          Button,
          { variant: 'secondary', disabled: page <= 1, onClick: () => setPage((p) => Math.max(1, p - 1)) },
          labels.prevPage,
        ),
        h('span', { className: 'text-sm text-ink-muted' }, fillLabel(labels.page, { page })),
        h(
          Button,
          { variant: 'secondary', disabled: page * 20 >= data.total, onClick: () => setPage((p) => p + 1) },
          labels.nextPage,
        ),
      ),
    );
  }

  return h(
    'div',
    { className: cx('flex flex-col gap-4 lg:flex-row lg:items-start', props.className) },
    h('div', { className: 'lg:w-72 lg:shrink-0' }, filterPanel),
    h(
      'div',
      { className: 'flex flex-1 flex-col gap-4' },
      coverageBar,
      findingMore,
      body,
      h(Disclaimer, { kind: 'coverage' }),
    ),
  );
}
