'use client';
/**
 * M04 — <CostBadge action country? quantity? /> (IF-04a, REQ-054).
 *
 * Shows what an action costs, in credits (and rupees when the catalogue publishes a rate), before
 * the user commits. Prices come only from GET /api/prices (IF-28c, served by M28), cached per
 * catalogue version and shared by every badge on the page.
 *
 * Edge case (LLD M04): if the price cannot be loaded, the badge shows "Price unavailable" and
 * calls `onUnavailable`, and the parent must disable the action.
 */
import { createElement as h, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toIntlLocale } from '../../../i18n/locales.js';
import {
  defaultPriceClient,
  PriceUnavailableError,
  resolveCost,
  type CostQuote,
  type CostResolution,
  type PriceAction,
  type PriceCatalogueDto,
  type PriceClient,
} from '../pricing/prices.js';
import { cx, Icon } from './primitives.js';

export interface CostBadgeProps {
  action: PriceAction;
  /** ISO-3166 alpha-2 country, for per-country multipliers. */
  country?: string;
  quantity?: number;
  /** Called once each time the badge enters the "unavailable" state; the parent disables the action. */
  onUnavailable?: (reason: string) => void;
  /** Called with the displayed quote, e.g. so a confirm dialog can repeat the exact figure. */
  onQuote?: (quote: CostQuote) => void;
  /** Catalogue the server rendered with; seeds the shared cache so no extra request is made. */
  initialCatalogue?: PriceCatalogueDto | null;
  /** Injectable for tests and storybook; defaults to the shared client. */
  client?: PriceClient;
  className?: string;
}

type Translate = ((key: string, values?: Record<string, string | number | Date>) => string) & {
  has?: (key: string) => boolean;
};

function formatInr(amount: number, locale: string): string {
  return new Intl.NumberFormat(toIntlLocale(locale), {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatMultiplier(multiplier: number, locale: string): string {
  return new Intl.NumberFormat(toIntlLocale(locale), { maximumFractionDigits: 2 }).format(multiplier);
}

function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([toIntlLocale(locale)], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface CostText {
  main: string;
  details: string[];
}

/** Builds the badge text for a resolution. Exported for reuse by confirm dialogs. */
export function describeCost(t: Translate, locale: string, resolution: CostResolution): CostText {
  if (resolution.state === 'loading') return { main: t('loading'), details: [] };
  if (resolution.state === 'unavailable') return { main: t('unavailable'), details: [t('unavailableHint')] };
  const q = resolution.quote;
  const details: string[] = [];
  if (q.quantity > 1 && !q.isFree) details.push(t('perItem', { unit: q.unitCredits, quantity: q.quantity }));
  if (q.country !== null && q.multiplier !== 1) {
    details.push(
      t('countryMultiplier', { country: countryName(q.country, locale), multiplier: formatMultiplier(q.multiplier, locale) }),
    );
  }
  if (q.isFree) return { main: t('free'), details };
  const main =
    q.inr !== null ? t('creditsWithInr', { credits: q.credits, inr: formatInr(q.inr, locale) }) : t('credits', { credits: q.credits });
  return { main, details };
}

const STATE_CLASSES: Record<CostResolution['state'], string> = {
  loading: 'text-ink-muted',
  ready: 'bg-brand-50 text-brand-800',
  unavailable: 'bg-caution-50 text-caution-800',
};

export function CostBadge(props: CostBadgeProps): ReactNode {
  const { action, country, quantity = 1, onUnavailable, onQuote, initialCatalogue, className } = props;
  const client: PriceClient = props.client ?? defaultPriceClient;
  const t: Translate = useTranslations('cost');
  const locale: string = useLocale();

  if (initialCatalogue && client.peek() === null) client.prime(initialCatalogue);

  const [catalogue, setCatalogue]: [PriceCatalogueDto | null, (next: PriceCatalogueDto | null) => void] = useState(
    initialCatalogue ?? client.peek(),
  );
  const [fetchError, setFetchError]: [string | null, (next: string | null) => void] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.getCatalogue().then(
      (next: PriceCatalogueDto) => {
        if (cancelled) return;
        setCatalogue(next);
        setFetchError(null);
      },
      (err: unknown) => {
        if (cancelled) return;
        setFetchError(err instanceof PriceUnavailableError ? err.reason : 'fetch_failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const resolution: CostResolution = useMemo(
    () => resolveCost(catalogue, fetchError, action, { country, quantity }),
    [catalogue, fetchError, action, country, quantity],
  );

  // Keep the latest callbacks without re-running effects when the parent passes new closures.
  const callbacks = useRef({ onUnavailable, onQuote });
  callbacks.current = { onUnavailable, onQuote };
  const reported = useRef<string | null>(null);

  useEffect(() => {
    const signature =
      resolution.state === 'ready'
        ? `ready|${resolution.quote.catalogueVersion}|${action}|${country ?? ''}|${quantity}`
        : resolution.state === 'unavailable'
          ? `unavailable|${resolution.reason}|${action}|${country ?? ''}|${quantity}`
          : null;
    if (signature === null || reported.current === signature) return;
    reported.current = signature;
    if (resolution.state === 'unavailable') callbacks.current.onUnavailable?.(resolution.reason);
    else if (resolution.state === 'ready') callbacks.current.onQuote?.(resolution.quote);
  }, [resolution, action, country, quantity]);

  const text = describeCost(t, locale, resolution);
  const version = resolution.state === 'ready' ? resolution.quote.catalogueVersion : undefined;

  return h(
    'span',
    {
      role: 'status',
      'aria-live': 'polite',
      'aria-busy': resolution.state === 'loading',
      'data-state': resolution.state,
      'data-catalogue-version': version,
      // Fixed height and minimum width so swapping "Checking price…" for the price causes no layout shift.
      className: cx(
        'inline-flex min-h-7 min-w-28 flex-wrap items-center gap-x-1.5 rounded-md px-2 py-0.5 text-sm font-medium',
        STATE_CLASSES[resolution.state],
        className,
      ),
    },
    h(Icon, { name: resolution.state === 'unavailable' ? 'info' : 'coin', className: 'h-4 w-4' }),
    h('span', null, text.main),
    text.details.length > 0 ? h('span', { className: 'w-full text-xs font-normal opacity-80' }, text.details.join(' · ')) : null,
  );
}
