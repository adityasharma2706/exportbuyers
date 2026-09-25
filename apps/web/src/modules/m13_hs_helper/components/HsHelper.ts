'use client';
/**
 * M13 — HS helper UI (REQ-005/006/007, REQ-004 anonymous try).
 *
 *   • free-text → suggested 6/8-digit codes with confidence and explanation
 *   • browse chapter → heading → subheading → ITC-HS line
 *   • direct code entry
 *   • export policy status + official link + "confirm with DGFT/CHA"
 *   • "Use this code" saves {code, version} to the workspace (signed in) or the anonymous session
 *
 * All text arrives pre-resolved in `labels` (see labels.ts); nothing here is literal UI text.
 * The standard HS disclaimer is rendered by the page with M04 <Disclaimer kind="hs" />.
 */
import { createElement as h, useCallback, useState, type ReactNode } from 'react';
import { Button, Card, Link, Pill, ROUTES, cx, type PillTone } from '../../m04_ui/index.js';
import type { ExportPolicy, HsLevel } from '../../m12_hs/index.js';
import { fillLabel, type HsHelperLabelKey, type HsHelperLabels } from '../labels.js';
import type { HsBrowseDto, HsCandidateDto, HsCodeDetailDto, HsNodeDto, HsSavedSelectionDto, HsSuggestResponse } from '../types.js';

export interface HsHelperProps {
  labels: HsHelperLabels;
  /** When set (signed-in user), "Use this code" saves to this workspace; otherwise to the anonymous session. */
  workspaceId?: string | null;
  /** Called after a successful save. */
  onSaved?: (saved: HsSavedSelectionDto) => void;
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

/** Copies a plain JSON object's own entries into a fresh record; non-objects yield an empty record. */
function toRecord(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = val;
  }
  return out;
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

function toUiError(e: unknown, labels: HsHelperLabels, context: { code?: string | undefined; validationKey?: HsHelperLabelKey | undefined }): UiError {
  if (e instanceof ApiError) {
    if (e.code === 'RATE_LIMITED') {
      if (e.details.challenge === true) return { message: labels.challenge, signup: false };
      const secs = typeof e.details.retryAfterSec === 'number' ? e.details.retryAfterSec : 3600;
      return { message: fillLabel(labels.rateLimited, { minutes: Math.max(1, Math.ceil(secs / 60)) }), signup: true };
    }
    if (e.code === 'NOT_FOUND' && context.code) return { message: fillLabel(labels.notFound, { code: context.code }), signup: false };
    if (e.code === 'VALIDATION' && context.validationKey) return { message: labels[context.validationKey], signup: false };
    if (e.code === 'UNAUTHENTICATED' || e.code === 'SIGNUP_REQUIRED') return { message: labels.signInRequired, signup: true };
  }
  return { message: labels.error, signup: false };
}

// ---- presentation helpers ---------------------------------------------------------------------

const LEVEL_KEY: Record<HsLevel, HsHelperLabelKey> = {
  chapter: 'levelChapter',
  heading: 'levelHeading',
  subheading: 'levelSubheading',
  national8: 'levelNational8',
};

const POLICY_KEY: Record<ExportPolicy, HsHelperLabelKey> = {
  free: 'policyFree',
  restricted: 'policyRestricted',
  prohibited: 'policyProhibited',
  ste: 'policySte',
};

const POLICY_TONE: Record<ExportPolicy, PillTone> = {
  free: 'positive',
  restricted: 'caution',
  prohibited: 'negative',
  ste: 'caution',
};

/** Formats 01012100 → 0101.21.00 and 010121 → 0101.21 for readability. */
export function formatHsCode(code: string): string {
  if (code.length <= 4) return code;
  const parts = [code.slice(0, 4), code.slice(4, 6)];
  if (code.length > 6) parts.push(code.slice(6));
  return parts.join('.');
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

interface PolicyInfo {
  level: HsLevel;
  exportPolicy?: ExportPolicy | null;
  policyUrl?: string | null;
  policyConditions?: string | null;
}

function PolicyBlock(props: { info: PolicyInfo; labels: HsHelperLabels }): ReactNode {
  const { info, labels } = props;
  if (info.level !== 'national8') {
    return h('p', { className: 'text-sm text-ink-muted' }, labels.pick8Digit);
  }
  const policy = info.exportPolicy ?? null;
  const url = safeHttpUrl(info.policyUrl);
  return h(
    'div',
    { className: 'flex flex-col gap-1 text-sm' },
    h(
      'div',
      { className: 'flex flex-wrap items-center gap-2' },
      h('span', { className: 'font-medium text-ink' }, labels.policyLabel),
      h(Pill, { tone: policy ? POLICY_TONE[policy] : 'neutral' }, policy ? labels[POLICY_KEY[policy]] : labels.policyUnknown),
      url
        ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', className: 'text-brand-700 underline' }, labels.policyLink)
        : null,
    ),
    info.policyConditions ? h('p', { className: 'text-ink-muted' }, info.policyConditions) : null,
    h('p', { className: 'text-ink-muted' }, labels.policyConfirm),
  );
}

interface CodeCardProps {
  labels: HsHelperLabels;
  code: string;
  level: HsLevel;
  version: string;
  description: string;
  confidence?: number | undefined;
  explanation?: string | null | undefined;
  policy: PolicyInfo;
  saving: boolean;
  onUse: () => void;
  extra?: ReactNode;
}

function CodeCard(props: CodeCardProps): ReactNode {
  const { labels } = props;
  return h(
    Card,
    { as: 'li', className: 'flex flex-col gap-2' },
    h(
      'div',
      { className: 'flex flex-wrap items-baseline gap-2' },
      h('span', { className: 'font-mono text-lg font-semibold text-ink' }, formatHsCode(props.code)),
      h(Pill, { tone: 'info' }, labels[LEVEL_KEY[props.level]]),
      props.confidence !== undefined
        ? h(Pill, { tone: 'neutral' }, fillLabel(labels.confidence, { pct: Math.round(props.confidence * 100) }))
        : null,
    ),
    h('p', { className: 'text-ink' }, props.description),
    props.explanation ? h('p', { className: 'text-sm text-ink-muted' }, props.explanation) : null,
    h('p', { className: 'text-xs text-ink-muted' }, fillLabel(labels.versionLabel, { version: props.version })),
    h(PolicyBlock, { info: props.policy, labels }),
    h(
      'div',
      { className: 'flex flex-wrap gap-2' },
      h(Button, { variant: 'primary', disabled: props.saving, onClick: props.onUse }, props.saving ? labels.saving : labels.useCode),
      props.extra ?? null,
    ),
  );
}

function ErrorNote(props: { error: UiError | null; labels: HsHelperLabels }): ReactNode {
  if (!props.error) return null;
  return h(
    'div',
    { role: 'alert', className: 'flex flex-col gap-2 rounded-md bg-danger-50 p-3 text-sm text-danger-700' },
    h('p', null, props.error.message),
    props.error.signup ? h(Link, { href: ROUTES.signUp, className: 'font-medium underline' }, props.labels.signUp) : null,
  );
}

// ---- component --------------------------------------------------------------------------------

interface SaveState {
  pendingKey: string | null;
  message: string | null;
  error: UiError | null;
}

interface BrowseState {
  open: boolean;
  loading: boolean;
  data: HsBrowseDto | null;
  error: UiError | null;
}

export function HsHelper(props: HsHelperProps): ReactNode {
  const { labels, workspaceId, onSaved } = props;

  const [text, setText] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<HsSuggestResponse | null>(null);
  const [suggestError, setSuggestError] = useState<UiError | null>(null);

  const [direct, setDirect] = useState('');
  const [directLoading, setDirectLoading] = useState(false);
  const [directResult, setDirectResult] = useState<HsCodeDetailDto | null>(null);
  const [directError, setDirectError] = useState<UiError | null>(null);

  const [browseState, setBrowseState] = useState<BrowseState>({ open: false, loading: false, data: null, error: null });
  const [save, setSave] = useState<SaveState>({ pendingKey: null, message: null, error: null });

  const runSuggest = useCallback(async () => {
    const t = text.trim();
    if (Array.from(t).length < 3 || Array.from(t).length > 300) {
      setSuggestError({ message: labels.invalidText, signup: false });
      return;
    }
    setSuggesting(true);
    setSuggestError(null);
    try {
      setSuggestion(await api<HsSuggestResponse>('/api/hs/suggest', { text: t }));
    } catch (e) {
      setSuggestion(null);
      setSuggestError(toUiError(e, labels, { validationKey: 'invalidText' }));
    } finally {
      setSuggesting(false);
    }
  }, [text, labels]);

  const runDirect = useCallback(async () => {
    const code = direct.replace(/[\s.-]/g, '');
    if (!/^([0-9]{4}|[0-9]{6}|[0-9]{8})$/.test(code)) {
      setDirectError({ message: labels.invalidCode, signup: false });
      setDirectResult(null);
      return;
    }
    setDirectLoading(true);
    setDirectError(null);
    try {
      setDirectResult(await api<HsCodeDetailDto>(`/api/hs/code/${encodeURIComponent(code)}`));
    } catch (e) {
      setDirectResult(null);
      setDirectError(toUiError(e, labels, { code, validationKey: 'invalidCode' }));
    } finally {
      setDirectLoading(false);
    }
  }, [direct, labels]);

  const loadBrowse = useCallback(
    async (parent: string | null, version?: string) => {
      setBrowseState((s) => ({ ...s, open: true, loading: true, error: null }));
      const params = new URLSearchParams();
      if (parent) params.set('parent', parent);
      if (version) params.set('version', version);
      const qs = params.toString();
      try {
        const data = await api<HsBrowseDto>(`/api/hs/browse${qs ? `?${qs}` : ''}`);
        setBrowseState({ open: true, loading: false, data, error: null });
      } catch (e) {
        setBrowseState((s) => ({ ...s, loading: false, error: toUiError(e, labels, { code: parent ?? undefined }) }));
      }
    },
    [labels],
  );

  const saveCode = useCallback(
    async (code: string, version: string) => {
      const key = `${version}:${code}`;
      setSave({ pendingKey: key, message: null, error: null });
      try {
        const path = workspaceId ? `/api/workspaces/${encodeURIComponent(workspaceId)}/hs` : '/api/anon/hs';
        const saved = await api<HsSavedSelectionDto>(path, { code, version });
        const vals = { code: formatHsCode(saved.hs.code), version: saved.hs.version };
        const template = workspaceId ? labels.saved : saved.persisted ? labels.savedAnon : labels.savedNotPersisted;
        setSave({ pendingKey: null, message: fillLabel(template, vals), error: null });
        onSaved?.(saved);
      } catch (e) {
        setSave({ pendingKey: null, message: null, error: toUiError(e, labels, { code }) });
      }
    },
    [workspaceId, labels, onSaved],
  );

  const cardFor = (
    n: HsCandidateDto | HsNodeDto,
    opts: { confidence?: number; explanation?: string | null; extra?: ReactNode },
  ): ReactNode =>
    h(CodeCard, {
      key: `${n.version}:${n.code}`,
      labels,
      code: n.code,
      level: n.level,
      version: n.version,
      description: n.description,
      confidence: opts.confidence,
      explanation: opts.explanation,
      policy: { level: n.level, exportPolicy: n.exportPolicy ?? null, policyUrl: n.policyUrl ?? null, policyConditions: n.policyConditions ?? null },
      saving: save.pendingKey === `${n.version}:${n.code}`,
      onUse: () => void saveCode(n.code, n.version),
      extra: opts.extra,
    });

  // -- suggest section --
  const suggestSection = h(
    'section',
    { 'aria-labelledby': 'hs-suggest-heading', className: 'flex flex-col gap-3' },
    h('h2', { id: 'hs-suggest-heading', className: 'text-lg font-semibold text-ink' }, labels.describeLabel),
    h(
      'form',
      {
        className: 'flex flex-col gap-2 sm:flex-row',
        onSubmit: (ev: { preventDefault(): void }) => {
          ev.preventDefault();
          void runSuggest();
        },
      },
      h('input', {
        id: 'hs-text',
        type: 'text',
        value: text,
        maxLength: 300,
        'aria-label': labels.describeLabel,
        'aria-describedby': 'hs-text-example hs-text-hint',
        onChange: (ev: { target: { value: string } }) => setText(ev.target.value),
        className: 'min-h-11 flex-1 rounded-md border border-line bg-surface px-3 text-base text-ink',
      }),
      h(Button, { type: 'submit', disabled: suggesting }, suggesting ? labels.suggesting : labels.suggestButton),
    ),
    h('p', { id: 'hs-text-example', className: 'text-sm italic text-ink-muted' }, labels.describeExample),
    h('p', { id: 'hs-text-hint', className: 'text-sm text-ink-muted' }, labels.describeHint),
    h(ErrorNote, { error: suggestError, labels }),
    suggestion
      ? h(
          'div',
          { className: 'flex flex-col gap-3', 'aria-live': 'polite' },
          h('h3', { className: 'font-semibold text-ink' }, labels.resultsHeading),
          suggestion.degraded && suggestion.candidates.length > 0
            ? h('p', { className: 'text-sm text-caution-700' }, labels.degradedNote)
            : null,
          suggestion.candidates.length === 0
            ? h(
                'div',
                { className: 'flex flex-col gap-2' },
                h('p', { className: 'text-ink-muted' }, labels.noResults),
                h(Button, { variant: 'secondary', onClick: () => void loadBrowse(null) }, labels.browseButton),
              )
            : h(
                'ul',
                { className: 'flex flex-col gap-3' },
                ...suggestion.candidates.map((c) => cardFor(c, { confidence: c.confidence, explanation: c.explanation })),
              ),
        )
      : null,
  );

  // -- direct entry section --
  const directSection = h(
    'section',
    { 'aria-labelledby': 'hs-direct-heading', className: 'flex flex-col gap-3' },
    h('h2', { id: 'hs-direct-heading', className: 'text-lg font-semibold text-ink' }, labels.directHeading),
    h('label', { htmlFor: 'hs-direct', className: 'text-sm font-medium text-ink' }, labels.directLabel),
    h(
      'form',
      {
        className: 'flex flex-col gap-2 sm:flex-row',
        onSubmit: (ev: { preventDefault(): void }) => {
          ev.preventDefault();
          void runDirect();
        },
      },
      h('input', {
        id: 'hs-direct',
        type: 'text',
        inputMode: 'numeric',
        value: direct,
        maxLength: 12,
        onChange: (ev: { target: { value: string } }) => setDirect(ev.target.value),
        className: 'min-h-11 flex-1 rounded-md border border-line bg-surface px-3 font-mono text-base text-ink',
      }),
      h(Button, { type: 'submit', variant: 'secondary', disabled: directLoading }, directLoading ? labels.loading : labels.directButton),
    ),
    h(ErrorNote, { error: directError, labels }),
    directResult
      ? h(
          'ul',
          { className: 'flex flex-col gap-3' },
          cardFor(directResult, {
            extra: directResult.hasChildren
              ? h(
                  Button,
                  { variant: 'ghost', onClick: () => void loadBrowse(directResult.code, directResult.version) },
                  fillLabel(labels.browseOpen, { code: formatHsCode(directResult.code) }),
                )
              : null,
          }),
        )
      : null,
  );

  // -- browse section --
  const data = browseState.data;
  const trail: HsNodeDto[] = data?.parent ? [...data.parent.path, data.parent] : [];
  const browseSection = h(
    'section',
    { 'aria-labelledby': 'hs-browse-heading', className: 'flex flex-col gap-3' },
    h('h2', { id: 'hs-browse-heading', className: 'text-lg font-semibold text-ink' }, labels.browseHeading),
    !browseState.open
      ? h(Button, { variant: 'secondary', onClick: () => void loadBrowse(null) }, labels.browseButton)
      : null,
    h(ErrorNote, { error: browseState.error, labels }),
    browseState.open && browseState.loading ? h('p', { className: 'text-sm text-ink-muted', 'aria-live': 'polite' }, labels.loading) : null,
    data
      ? h(
          'nav',
          { 'aria-label': labels.breadcrumb },
          h(
            'ol',
            { className: 'flex flex-wrap items-center gap-1 text-sm' },
            h(
              'li',
              { key: 'root' },
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => void loadBrowse(null, data.version) }, labels.browseRoot),
            ),
            ...trail.map((n) =>
              h(
                'li',
                { key: n.code },
                h(
                  Button,
                  { variant: 'ghost', size: 'sm', onClick: () => void loadBrowse(n.code, data.version) },
                  formatHsCode(n.code),
                ),
              ),
            ),
          ),
        )
      : null,
    data && data.parent ? h('ul', { className: 'flex flex-col gap-3' }, cardFor(data.parent, {})) : null,
    data
      ? data.nodes.length === 0
        ? h('p', { className: 'text-sm text-ink-muted' }, labels.browseEmpty)
        : h(
            'ul',
            { className: 'flex flex-col divide-y divide-line rounded-md border border-line' },
            ...data.nodes.map((n) =>
              h(
                'li',
                { key: `${n.version}:${n.code}`, className: 'flex flex-col gap-2 p-3 sm:flex-row sm:items-center' },
                h(
                  'div',
                  { className: 'flex flex-1 flex-col' },
                  h('span', { className: 'font-mono font-semibold text-ink' }, formatHsCode(n.code)),
                  h('span', { className: 'text-sm text-ink' }, n.description),
                  n.level === 'national8' && n.exportPolicy
                    ? h(Pill, { tone: POLICY_TONE[n.exportPolicy], className: 'mt-1 self-start' }, labels[POLICY_KEY[n.exportPolicy]])
                    : null,
                ),
                n.hasChildren
                  ? h(
                      Button,
                      {
                        variant: 'secondary',
                        size: 'sm',
                        'aria-label': fillLabel(labels.browseOpen, { code: formatHsCode(n.code) }),
                        onClick: () => void loadBrowse(n.code, data.version),
                      },
                      fillLabel(labels.browseOpen, { code: formatHsCode(n.code) }),
                    )
                  : h(
                      Button,
                      {
                        variant: 'primary',
                        size: 'sm',
                        disabled: save.pendingKey === `${n.version}:${n.code}`,
                        onClick: () => void saveCode(n.code, n.version),
                      },
                      save.pendingKey === `${n.version}:${n.code}` ? labels.saving : labels.useCode,
                    ),
              ),
            ),
          )
      : null,
  );

  return h(
    'div',
    { className: cx('flex flex-col gap-8', props.className) },
    save.message || save.error
      ? h(
          'div',
          { 'aria-live': 'polite' },
          save.message ? h('p', { role: 'status', className: 'rounded-md bg-positive-50 p-3 text-sm text-positive-700' }, save.message) : null,
          h(ErrorNote, { error: save.error, labels }),
          save.message && !workspaceId
            ? h(Link, { href: ROUTES.signUp, className: 'mt-2 inline-block text-sm font-medium text-brand-700 underline' }, labels.signUp)
            : null,
        )
      : null,
    suggestSection,
    directSection,
    browseSection,
  );
}
