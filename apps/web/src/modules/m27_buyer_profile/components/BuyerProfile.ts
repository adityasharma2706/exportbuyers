'use client';
/**
 * M27 — Buyer profile UI (REQ-021, REQ-017, REQ-022, REQ-024, REQ-027, REQ-028, REQ-029).
 *
 *   • overview: name, location, buyer type, status, website
 *   • "why this buyer" evidence — source type + last-checked/seen date per item (REQ-017)
 *   • activity/shipment summary: frequency, volume, last seen, main supplier (origin) countries
 *   • India / competitor sourcing, distinguishing "No" from "no shipment data" (REQ-022)
 *   • trust checklist + rollup + disclaimer (REQ-027, REQ-028), via M04's <TrustChecklist />
 *   • a prominent sanctions warning that disables reveal and draft (REQ-029)
 *   • contact *types*; "Reveal contacts" calls M29's POST /api/reveal once that module exists
 *   • a reserved drafts/notes/status section, filled in once M33/M34 register a shortlist provider
 *
 * All text arrives pre-resolved in `labels` (see labels.ts) or M04 components; nothing here is
 * literal UI text.
 */
import { createElement as h, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useLocale } from 'next-intl';
import {
  Button,
  Card,
  Disclaimer,
  Icon,
  Link,
  Pill,
  SignupGate,
  TrustChecklist,
  cx,
  toIntlLocale,
} from '../../m04_ui/index.js';
import type { TrustResultDto } from '../../m04_ui/index.js';
import { actionBlockedLabel, fillLabel } from '../labels.js';
import type { BuyerProfileLabels } from '../labels.js';
import type {
  ActivityItemDto,
  BuyerProfileResponseDto,
  ContactTypeDto,
  EvidenceItemDto,
  ProfileDto,
} from '../types.js';

export interface BuyerProfileProps {
  labels: BuyerProfileLabels;
  data: BuyerProfileResponseDto | null;
  loading: boolean;
  error: { message: string; signIn: boolean } | null;
  onRetry?: () => void;
  onRevealed?: (contacts: RevealedContactUi[]) => void;
  className?: string;
}

export interface RevealedContactUi {
  kind: string;
  value: string;
  deliverability: string;
  stale: boolean;
}

// ---- API client (mirrors M26's; not a shared module dependency — see M26's own comment) -------

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

function randomKey(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

interface RevealResponse {
  revealId: string;
  contacts: Array<{ assertionId: string; kind: string; value: string; deliverability: string; checkedAt: string; stale: boolean }>;
  creditsCharged: number;
}

// ---- presentation helpers ----------------------------------------------------------------------

function dateFmt(intlLocale: string): (iso: string | null) => string | null {
  const fmt = new Intl.DateTimeFormat(intlLocale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : fmt.format(d);
  };
}

function toTrustResultDto(trust: ProfileDto['trust']): TrustResultDto {
  return {
    level: trust.level,
    checks: trust.checks.map((c) => ({
      id: c.id,
      outcome: c.outcome,
      checkedAt: c.checkedAt,
      explanationKey: c.explanationKey ?? undefined,
    })),
  };
}

function EvidenceRow(props: { item: EvidenceItemDto; labels: BuyerProfileLabels; fmtDate: (iso: string | null) => string | null }): ReactNode {
  const { item, labels, fmtDate } = props;
  const checked = fmtDate(item.checkedAt) ?? fmtDate(item.observedAt);
  return h(
    'li',
    { className: 'flex flex-col gap-0.5 py-2' },
    h('p', { className: 'text-sm text-ink' }, item.snippet ?? labels.evidenceSnippetFallback),
    h(
      'p',
      { className: 'text-xs text-ink-muted' },
      item.sourceType,
      checked ? ` · ${fillLabel(labels.evidenceCheckedOn, { date: checked })}` : '',
    ),
  );
}

function originsList(origins: Record<string, number>, locale: string): string {
  const sorted = Object.entries(origins)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([cc]) => cc);
  if (sorted.length === 0) return '';
  try {
    return new Intl.ListFormat(toIntlLocale(locale), { style: 'long', type: 'conjunction' }).format(sorted);
  } catch {
    return sorted.join(', ');
  }
}

function ActivitySection(props: {
  activity: ActivityItemDto[];
  labels: BuyerProfileLabels;
  fmtDate: (iso: string | null) => string | null;
  locale: string;
}): ReactNode {
  const { activity, labels, fmtDate, locale } = props;
  if (activity.length === 0) return h('p', { className: 'text-sm text-ink-muted' }, labels.activityNone);
  return h(
    'ul',
    { className: 'flex flex-col gap-3' },
    ...activity.map((a) => {
      const lastSeen = fmtDate(a.lastSeen);
      const originText = originsList(a.origins, locale);
      return h(
        Card,
        { as: 'li', key: a.hsHeading, className: 'text-sm' },
        h('p', { className: 'font-medium text-ink' }, a.hsHeading),
        typeof a.shipments12m === 'number' ? h('p', { className: 'text-ink' }, fillLabel(labels.activityShipments, { count: a.shipments12m })) : null,
        typeof a.volumeKg12m === 'number' ? h('p', { className: 'text-ink' }, fillLabel(labels.activityVolume, { volume: a.volumeKg12m })) : null,
        lastSeen ? h('p', { className: 'text-ink-muted' }, fillLabel(labels.activityLastSeen, { date: lastSeen })) : null,
        originText ? h('p', { className: 'text-ink-muted' }, fillLabel(labels.activityOrigins, { list: originText })) : null,
      );
    }),
  );
}

function sourcingText(labels: BuyerProfileLabels, kind: 'india' | 'competitor', flag: 'yes' | 'no' | 'unknown'): string {
  if (kind === 'india') {
    return flag === 'yes' ? labels.sourcingIndiaYes : flag === 'no' ? labels.sourcingIndiaNo : labels.sourcingIndiaUnknown;
  }
  return flag === 'yes' ? labels.sourcingCompetitorYes : flag === 'no' ? labels.sourcingCompetitorNo : labels.sourcingCompetitorUnknown;
}

function SourcingSection(props: { sourcing: ProfileDto['sourcing']; hsHeadings: string[]; labels: BuyerProfileLabels }): ReactNode {
  const { sourcing, hsHeadings, labels } = props;
  const headings = hsHeadings.length > 0 ? hsHeadings : Object.keys(sourcing);
  if (headings.length === 0) return h('p', { className: 'text-sm text-ink-muted' }, labels.sourcingIndiaUnknown);
  return h(
    'ul',
    { className: 'flex flex-col gap-2' },
    ...headings.map((h_) => {
      const entry = sourcing[h_];
      const india = entry?.originIndia ?? 'unknown';
      const competitor = entry?.originCompetitor ?? 'unknown';
      return h(
        'li',
        { key: h_, className: 'text-sm text-ink' },
        h('p', { className: 'font-medium' }, h_),
        h('p', null, sourcingText(labels, 'india', india)),
        h('p', null, sourcingText(labels, 'competitor', competitor)),
      );
    }),
  );
}

function ContactsSection(props: {
  profile: ProfileDto;
  labels: BuyerProfileLabels;
  revealed: boolean;
  revealedContacts: RevealedContactUi[] | null;
  revealing: boolean;
  revealError: string | null;
  onReveal: () => void;
}): ReactNode {
  const { profile, labels, revealed, revealedContacts, revealing, revealError, onReveal } = props;
  const contacts: ContactTypeDto[] = profile.contacts;
  if (contacts.length === 0 && !revealed) {
    return h('p', { className: 'text-sm text-ink-muted' }, labels.contactsNone);
  }
  const action = profile.actions.reveal;
  return h(
    'div',
    { className: 'flex flex-col gap-2' },
    h(
      'div',
      { className: 'flex flex-wrap gap-1' },
      ...profile.contactTypes.map((k) => h(Pill, { key: k, tone: 'neutral' }, k)),
    ),
    revealed && revealedContacts
      ? h(
          'ul',
          { className: 'flex flex-col gap-1' },
          ...revealedContacts.map((c, i) =>
            h(
              'li',
              { key: `${c.kind}-${i}`, className: 'text-sm text-ink' },
              `${c.kind}: ${c.value}`,
              c.stale ? h(Pill, { tone: 'caution', className: 'ml-2' }, c.deliverability) : null,
            ),
          ),
        )
      : action.allowed
        ? h(
            'div',
            { className: 'flex flex-col gap-1' },
            h(Button, { variant: 'primary', onClick: onReveal, disabled: revealing }, revealing ? labels.revealing : labels.revealButton),
            revealError ? h('p', { role: 'alert', className: 'text-sm text-danger-700' }, revealError) : null,
          )
        : h('p', { className: 'text-sm text-ink-muted' }, actionBlockedLabel(labels, action.explanationKey)),
  );
}

function NotesAndDraftsSection(props: { data: BuyerProfileResponseDto; labels: BuyerProfileLabels }): ReactNode {
  const { data, labels } = props;
  const entry = data.shortlistEntry;
  return h(
    'div',
    { className: 'flex flex-col gap-3' },
    h(
      Card,
      { as: 'section' },
      h('h3', { className: 'text-sm font-semibold text-ink' }, labels.notesHeading),
      h('p', { className: 'mt-1 text-sm text-ink-muted' }, entry && entry.notesCount > 0 ? String(entry.status ?? '') : labels.notesNone),
    ),
    h(
      Card,
      { as: 'section' },
      h('h3', { className: 'text-sm font-semibold text-ink' }, labels.draftsHeading),
      h('p', { className: 'mt-1 text-sm text-ink-muted' }, entry && entry.draftsCount > 0 ? String(entry.draftsCount) : labels.draftsNone),
      // REQ-029: outreach drafting itself is disabled (with an explanation) for a sanctioned or
      // otherwise blocked company, even before M33/M34 exist to act on it.
      !data.profile.actions.draft.allowed
        ? h('p', { className: 'mt-1 text-sm text-danger-700' }, actionBlockedLabel(labels, data.profile.actions.draft.explanationKey))
        : null,
    ),
  );
}

// ---- component --------------------------------------------------------------------------------

export function BuyerProfile(props: BuyerProfileProps): ReactNode {
  const { labels, data, loading, error, onRetry, onRevealed, className } = props;
  const locale: string = useLocale();
  const intlLocale = toIntlLocale(locale);
  const fmtDate = useMemo(() => dateFmt(intlLocale), [intlLocale]);

  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealedContacts, setRevealedContacts] = useState<RevealedContactUi[] | null>(null);

  const reveal = useCallback(() => {
    if (!data) return;
    setRevealing(true);
    setRevealError(null);
    api<RevealResponse>('/api/reveal', 'POST', { companyId: data.profile.companyId, idempotencyKey: randomKey() })
      .then((res) => {
        const contacts: RevealedContactUi[] = res.contacts.map((c) => ({
          kind: c.kind,
          value: c.value,
          deliverability: c.deliverability,
          stale: c.stale === true,
        }));
        setRevealedContacts(contacts);
        onRevealed?.(contacts);
      })
      .catch((e: unknown) => {
        setRevealError(e instanceof ApiError && e.code === 'SANCTIONS_BLOCKED' ? labels.revealBlocked : labels.error);
      })
      .finally(() => setRevealing(false));
  }, [data, labels, onRevealed]);

  if (loading && !data) {
    return h('p', { className: cx('text-sm text-ink-muted', className), 'aria-live': 'polite' }, labels.loading);
  }
  if (error) {
    return h(
      'div',
      { role: 'alert', className: cx('flex flex-col gap-2 rounded-md bg-danger-50 p-3 text-sm text-danger-700', className) },
      h('p', null, error.message),
      error.signIn ? h(SignupGate, { reason: 'buyerProfile' }) : null,
      onRetry && !error.signIn ? h(Button, { variant: 'secondary', size: 'sm', onClick: onRetry }, labels.retry) : null,
    );
  }
  if (!data) return null;

  const { profile } = data;
  const sanctionsWarning = profile.sanctionsWarning;

  return h(
    'div',
    { className: cx('flex flex-col gap-6', className) },
    data.redirectedFrom ? h('p', { role: 'status', className: 'text-xs text-ink-muted' }, labels.redirected) : null,
    h(
      'header',
      { className: 'flex flex-col gap-2' },
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2' },
        h('h1', { className: 'text-xl font-semibold text-ink' }, profile.name),
        sanctionsWarning ? h(Pill, { tone: 'negative' }, h(Icon, { name: 'shield', className: 'h-3.5 w-3.5' }), labels.sanctionsWarningHeading) : null,
        profile.status === 'closed' ? h(Pill, { tone: 'neutral' }, labels.statusClosed) : null,
      ),
      h('p', { className: 'text-sm text-ink-muted' }, [profile.city, profile.country].filter(Boolean).join(', ')),
      h('p', { className: 'text-sm text-ink' }, profile.buyerType?.type ?? labels.buyerTypeUnknown),
      profile.website
        ? h(
            'a',
            { href: profile.website.startsWith('http') ? profile.website : `https://${profile.website}`, target: '_blank', rel: 'noopener noreferrer', className: 'text-sm font-medium text-brand-700 underline' },
            profile.website,
          )
        : h('p', { className: 'text-sm text-ink-muted' }, labels.websiteNone),
    ),

    sanctionsWarning
      ? h(
          Card,
          { as: 'section', className: 'border-danger-200 bg-danger-50' },
          h('h2', { className: 'text-base font-semibold text-danger-700' }, labels.sanctionsWarningHeading),
          h('p', { className: 'mt-1 text-sm text-danger-700' }, labels.sanctionsWarningBody),
          h(Disclaimer, { kind: 'sanctions', className: 'mt-2' }),
        )
      : null,

    h(
      Card,
      { as: 'section' },
      h('h2', { className: 'text-base font-semibold text-ink' }, labels.evidenceHeading),
      profile.evidence.length === 0
        ? h('p', { className: 'mt-2 text-sm text-ink-muted' }, labels.evidenceNone)
        : h(
            'ul',
            { className: 'mt-2 divide-y divide-line' },
            ...profile.evidence.map((e) => h(EvidenceRow, { key: e.assertionId, item: e, labels, fmtDate })),
          ),
    ),

    h(
      Card,
      { as: 'section' },
      h('h2', { className: 'text-base font-semibold text-ink' }, labels.activityHeading),
      h('div', { className: 'mt-2' }, h(ActivitySection, { activity: profile.activity, labels, fmtDate, locale: intlLocale })),
    ),

    h(
      Card,
      { as: 'section' },
      h('h2', { className: 'text-base font-semibold text-ink' }, labels.sourcingHeading),
      h('div', { className: 'mt-2' }, h(SourcingSection, { sourcing: profile.sourcing, hsHeadings: profile.hsHeadings, labels })),
    ),

    h(TrustChecklist, { result: toTrustResultDto(profile.trust) }),
    h(Disclaimer, { kind: 'trust' }),

    h(
      Card,
      { as: 'section' },
      h('h2', { className: 'text-base font-semibold text-ink' }, labels.contactsHeading),
      h(
        'div',
        { className: 'mt-2' },
        h(ContactsSection, { profile, labels, revealed: data.revealed || revealedContacts !== null, revealedContacts, revealing, revealError, onReveal: reveal }),
      ),
    ),

    data.redFlags.length > 0
      ? h(
          Card,
          { as: 'section', className: 'border-caution-200 bg-caution-50' },
          h('h2', { className: 'text-base font-semibold text-caution-800' }, labels.redFlagsHeading),
          h(
            'ul',
            { className: 'mt-2 flex flex-col gap-1' },
            ...data.redFlags.map((f) => h('li', { key: f.id, className: 'text-sm text-caution-800' }, f.explanationKey)),
          ),
        )
      : null,

    h(NotesAndDraftsSection, { data, labels }),

    h(
      'div',
      { className: 'flex flex-wrap gap-2' },
      h(Link, { href: '/buyers', className: 'text-sm font-medium text-brand-700 underline' }, labels.backToSearch),
    ),
  );
}
