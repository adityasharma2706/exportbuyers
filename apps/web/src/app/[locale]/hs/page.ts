/**
 * M13 — HS helper page (/[locale]/hs). Public: anonymous visitors can try it within the
 * rate limits (REQ-004). `?workspace=<id>` makes "Use this code" save to that workspace; the
 * API checks that the signed-in account owns it.
 */
import { createElement as h, type ReactNode } from 'react';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation.js';
import { Disclaimer, isLocale, type Messages } from '../../../modules/m04_ui/index.js';
import { HsHelper } from '../../../modules/m13_hs_helper/components/HsHelper.js';
import { resolveHsHelperLabels } from '../../../modules/m13_hs_helper/labels.js';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ workspace?: string | string[] }>;
}

const WORKSPACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function HsHelperPage({ params, searchParams }: PageProps): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
    return null;
  }
  setRequestLocale(locale);
  const messages = (await getMessages()) as unknown as Messages;
  const labels = resolveHsHelperLabels(messages);

  const wsParam = searchParams ? (await searchParams).workspace : undefined;
  const rawWs = Array.isArray(wsParam) ? wsParam[0] : wsParam;
  const workspaceId = rawWs && WORKSPACE_ID_RE.test(rawWs) ? rawWs : null;

  return h(
    'div',
    { className: 'flex flex-col gap-6' },
    h(
      'section',
      { className: 'flex flex-col gap-2' },
      h('h1', { className: 'text-2xl font-bold text-ink' }, labels.title),
      h('p', { className: 'text-ink-muted' }, labels.intro),
    ),
    h(Disclaimer, { kind: 'hs' }),
    h(HsHelper, { labels, workspaceId }),
  );
}
