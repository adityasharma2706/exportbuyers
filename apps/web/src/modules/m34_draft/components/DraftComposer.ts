'use client';
/**
 * M34 — <DraftComposer /> (LLD M34 API): posts to POST /api/drafts, streams the model's reply in
 * as it arrives, appends the compliance footer once the stream's `footer` event lands, and lets
 * the seller edit the body before leaving the product "only by copy or mailto:" (LLD M34): those
 * two handoff buttons call POST /api/drafts/:id/handoff, which is what auto-advances the
 * shortlist entry to "Contacted" (M33's EV-09 handler).
 */
import { createElement as h, useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, Card, cx } from '../../m04_ui/index.js';
import type { DraftLabels } from '../labels.js';
import { DRAFT_TONES, type DraftHandoffVia, type DraftTone } from '../types.js';

export interface DraftComposerProps {
  entryId: string;
  labels: DraftLabels;
  /** 'en', or the ISO-639-1 code of the buyer country's primary language (LLD M34 API). */
  defaultLanguage?: string;
  /** Supplied by the parent page from an already-revealed (M29) contact, if any. Without it the
   * "Open in email" button is not shown — this module never has a contact value of its own. */
  mailtoAddress?: string;
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

async function parseErrorResponse(res: Response): Promise<ApiError> {
  const json: unknown = await res.json().catch(() => null);
  const err = json && typeof json === 'object' ? (json as { error?: { code?: unknown } }).error : undefined;
  return new ApiError(res.status, typeof err?.code === 'string' ? err.code : 'INTERNAL');
}

/** Splits an SSE byte stream into `{event, data}` frames (LLD M34 API wire format). */
function parseSseFrame(frame: string): { event?: string; data: unknown } | null {
  let event: string | undefined;
  let dataLine: string | undefined;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLine = line.slice('data:'.length).trim();
  }
  if (dataLine === undefined) return null;
  try {
    return { event, data: JSON.parse(dataLine) as unknown };
  } catch {
    return null;
  }
}

export function DraftComposer(props: DraftComposerProps): ReactNode {
  const { entryId, labels, defaultLanguage = 'en', mailtoAddress, className } = props;
  const [tone, setTone] = useState<DraftTone>('formal');
  const [language, setLanguage] = useState(defaultLanguage);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [footer, setFooter] = useState('');
  const [copied, setCopied] = useState(false);
  const savedBodyRef = useRef('');

  const errorLabel = useCallback(
    (err: ApiError): string => {
      if (err.code === 'RATE_LIMITED') return labels.errorRateLimited;
      if (err.code === 'SANCTIONS_BLOCKED' || err.code === 'POLICY_DENIED') return labels.errorSanctions;
      if (err.code === 'VALIDATION') return labels.errorIncompleteProfile;
      return labels.errorGeneric;
    },
    [labels],
  );

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    setDraftId(null);
    setBody('');
    setFooter('');
    savedBodyRef.current = '';

    let res: Response;
    try {
      res = await fetch('/api/drafts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify({ entryId, language, tone }),
      });
    } catch {
      setError(labels.errorGeneric);
      setGenerating(false);
      return;
    }

    if (!res.ok) {
      setError(errorLabel(await parseErrorResponse(res)));
      setGenerating(false);
      return;
    }
    if (!res.body) {
      setError(labels.errorGeneric);
      setGenerating(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let sep: number;
        // eslint-disable-next-line no-cond-assign
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          if (parsed.event === 'footer') {
            const d = parsed.data as { footer?: unknown };
            if (typeof d.footer === 'string') setFooter(d.footer);
          } else if (parsed.event === 'done') {
            const d = parsed.data as { draftId?: unknown };
            if (typeof d.draftId === 'string') setDraftId(d.draftId);
          } else if (parsed.event === 'error') {
            const d = parsed.data as { message?: unknown };
            setError(typeof d.message === 'string' ? d.message : labels.errorGeneric);
          } else {
            const d = parsed.data as { delta?: unknown };
            if (typeof d.delta === 'string') {
              const delta = d.delta;
              setBody((prev) => {
                const next = prev + delta;
                savedBodyRef.current = next;
                return next;
              });
            }
          }
        }
      }
    } catch {
      setError(labels.errorGeneric);
    } finally {
      setGenerating(false);
    }
  }, [entryId, language, tone, labels, errorLabel]);

  const onBodyChange = useCallback((e: { target: { value: string } }) => setBody(e.target.value), []);

  const saveEdit = useCallback(() => {
    if (!draftId || body === savedBodyRef.current) return;
    savedBodyRef.current = body;
    fetch(`/api/drafts/${draftId}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bodyEdited: body }),
    }).catch(() => undefined);
  }, [draftId, body]);

  const handoff = useCallback(
    (via: DraftHandoffVia) => {
      if (!draftId) return Promise.resolve();
      return fetch(`/api/drafts/${draftId}/handoff`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ via }),
      }).catch(() => undefined);
    },
    [draftId],
  );

  const fullMessage = footer ? `${body}\n\n${footer}` : body;

  const onCopy = useCallback(() => {
    saveEdit();
    void navigator.clipboard.writeText(fullMessage).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
    void handoff('copy');
  }, [fullMessage, saveEdit, handoff]);

  const onMailto = useCallback(() => {
    saveEdit();
    void handoff('mailto').finally(() => {
      const href = `mailto:${mailtoAddress ?? ''}?body=${encodeURIComponent(fullMessage)}`;
      window.location.href = href;
    });
  }, [fullMessage, mailtoAddress, saveEdit, handoff]);

  return h(
    Card,
    { as: 'section', className: cx('flex flex-col gap-4', className), 'aria-labelledby': 'draft-composer-heading' },
    h('h2', { id: 'draft-composer-heading', className: 'text-lg font-semibold text-ink' }, labels.title),

    h(
      'div',
      { className: 'flex flex-wrap items-end gap-3' },
      h(
        'label',
        { className: 'flex flex-col gap-1 text-sm font-medium text-ink' },
        labels.toneLabel,
        h(
          'select',
          {
            className: 'min-h-11 rounded-md border border-line px-3 text-base',
            value: tone,
            disabled: generating,
            onChange: (e: { target: { value: string } }) => setTone(e.target.value as DraftTone),
          },
          ...DRAFT_TONES.map((t) => h('option', { key: t, value: t }, t === 'formal' ? labels.toneFormal : labels.toneFriendly)),
        ),
      ),
      h(
        'label',
        { className: 'flex flex-col gap-1 text-sm font-medium text-ink' },
        labels.languageLabel,
        h('input', {
          className: 'min-h-11 w-24 rounded-md border border-line px-3 text-base lowercase',
          value: language,
          disabled: generating,
          maxLength: 2,
          onChange: (e: { target: { value: string } }) => setLanguage(e.target.value.toLowerCase()),
        }),
      ),
      h(Button, { variant: 'primary', disabled: generating, onClick: () => void generate() }, generating ? labels.generating : draftId ? labels.regenerate : labels.generate),
    ),

    error ? h('p', { role: 'alert', className: 'text-sm text-danger-700' }, error) : null,

    body || generating
      ? h(
          'div',
          { className: 'flex flex-col gap-2' },
          h('textarea', {
            className: 'min-h-40 rounded-md border border-line px-3 py-2 text-base',
            value: body,
            onChange: onBodyChange,
            onBlur: saveEdit,
            readOnly: generating,
          }),
          h('p', { className: 'text-xs text-ink-muted' }, labels.editableHint),
          footer
            ? h(
                'div',
                { className: 'rounded-md border border-line bg-surface-muted p-3' },
                h('p', { className: 'whitespace-pre-line text-sm text-ink-muted' }, footer),
                h('p', { className: 'mt-1 text-xs text-ink-muted' }, labels.footerHint),
              )
            : null,
        )
      : null,

    draftId
      ? h(
          'div',
          { className: 'flex flex-wrap gap-2' },
          h(Button, { variant: 'secondary', onClick: onCopy }, copied ? labels.copied : labels.copy),
          mailtoAddress ? h(Button, { variant: 'secondary', onClick: onMailto }, labels.mailto) : null,
          h('span', { className: 'self-center text-xs text-ink-muted' }, labels.savedHint),
        )
      : null,
  );
}
