/**
 * M04 — <SignupGate reason /> (IF-04a). Shown where an anonymous visitor hits a members-only
 * action (reveal, save, visitor limit…). `reason` selects `signupGate.reason.<reason>`; unknown
 * reasons fall back to the default text rather than rendering a raw key.
 */
import { createElement as h, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '../../../i18n/navigation.js';
import { ROUTES } from '../nav.js';
import { isSafeKeySegment } from '../wording.js';
import { buttonClasses, Card, cx } from './primitives.js';

export interface SignupGateProps {
  reason: string;
  /** Path to return to after sign-up; must be an internal path. */
  returnTo?: string;
  className?: string;
}

type Translate = ((key: string) => string) & { has: (key: string) => boolean };

/** Only same-site paths are allowed as return targets (prevents open redirects). */
export function safeReturnPath(path: string | undefined): string | null {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
  return path;
}

export function signupHref(base: string, returnTo: string | undefined): string {
  const safe = safeReturnPath(returnTo);
  return safe ? `${base}?next=${encodeURIComponent(safe)}` : base;
}

export function SignupGate(props: SignupGateProps): ReactNode {
  const { reason, returnTo, className } = props;
  const t: Translate = useTranslations('signupGate');
  const reasonKey = isSafeKeySegment(reason) && t.has(`reason.${reason}`) ? `reason.${reason}` : 'reason.default';
  const titleId = `signup-gate-${isSafeKeySegment(reason) ? reason : 'default'}`;

  return h(
    Card,
    { as: 'section', className: cx('text-center', className), 'aria-labelledby': titleId },
    h('h2', { id: titleId, className: 'text-lg font-semibold text-ink' }, t('title')),
    h('p', { className: 'mt-2 text-ink-muted' }, t(reasonKey)),
    h(
      'div',
      { className: 'mt-4 flex flex-col items-center gap-2' },
      h(Link, { href: signupHref(ROUTES.signUp, returnTo), className: buttonClasses('primary', 'lg', 'w-full sm:w-auto') }, t('cta')),
      h('p', { className: 'text-sm text-ink-muted' }, t('noCard')),
      h(Link, { href: signupHref(ROUTES.signIn, returnTo), className: 'min-h-11 py-2 text-sm text-brand-700 underline' }, t('secondary')),
    ),
  );
}
