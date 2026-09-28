'use client';
/**
 * M31 — Cloudflare Turnstile widget. Renders the challenge if a site key is configured
 * (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, inlined at build time) and reports the resulting token to
 * the caller via `onToken`. Without a site key configured (local/dev, or Turnstile disabled on
 * the backend — M05's `guardAnonymous` skips the challenge whenever its own secret is unset) it
 * renders nothing and reports an empty token, matching M05's "degrade, don't lock visitors out"
 * behaviour (see m05_identity/guard.ts).
 */
import { createElement as h, useEffect, useId, useRef, useState, type ReactNode } from 'react';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void; 'error-callback'?: () => void },
  ): string;
  reset(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('turnstile script failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('turnstile script failed to load')));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileWidgetProps {
  onToken: (token: string) => void;
  className?: string;
}

/** Reads the public site key. Empty when Turnstile is not configured for this build. */
export function turnstileSiteKey(): string {
  return typeof process !== 'undefined' ? (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '') : '';
}

export function TurnstileWidget(props: TurnstileWidgetProps): ReactNode {
  const { onToken } = props;
  const siteKey = turnstileSiteKey();
  const containerId = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!siteKey) {
      onToken('');
      return;
    }
    let cancelled = false;
    void loadScript()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile) return;
        window.turnstile.render(ref.current, {
          sitekey: siteKey,
          callback: (token: string) => onToken(token),
          'expired-callback': () => onToken(''),
          'error-callback': () => {
            onToken('');
            setFailed(true);
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          onToken('');
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // Intentionally keyed on siteKey only: the widget renders once per mount, and onToken is
    // expected to be a stable state setter from the caller.
  }, [siteKey]);

  if (!siteKey || failed) return null;
  return h('div', { id: containerId, ref, className: props.className, 'aria-live': 'polite' });
}
