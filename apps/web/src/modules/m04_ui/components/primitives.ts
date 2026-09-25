/**
 * M04 — base component library. Tailwind utility classes over the design tokens defined in
 * src/app/globals.css. Server-renderable (no hooks), so they add no client JS on their own.
 *
 * None of these components contain text: callers pass translated strings as children.
 */
import { createElement as h, type ReactNode } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

// -------------------------------------------------------------------------------------------------
// Button
// -------------------------------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'border border-line bg-surface text-ink hover:bg-surface-muted',
  ghost: 'text-brand-700 hover:bg-brand-50',
  danger: 'bg-danger-600 text-white hover:bg-danger-700',
};

// Minimum 44 px touch target on every size except "sm", which is for dense desktop tables.
const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'min-h-11 px-4 text-base',
  lg: 'min-h-12 px-6 text-lg',
};

export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', extra?: string): string {
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], extra);
}

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  onClick?: (event: unknown) => void;
  className?: string;
  children?: ReactNode;
  'aria-describedby'?: string;
  'aria-label'?: string;
}

export function Button(props: ButtonProps): ReactNode {
  const { variant, size, type = 'button', className, children, ...rest } = props;
  return h('button', { ...rest, type, className: buttonClasses(variant, size, className) }, children);
}

// -------------------------------------------------------------------------------------------------
// Card
// -------------------------------------------------------------------------------------------------

export interface CardProps {
  as?: 'div' | 'section' | 'article' | 'li';
  className?: string;
  children?: ReactNode;
  'aria-labelledby'?: string;
}

export function Card(props: CardProps): ReactNode {
  const { as = 'div', className, children, ...rest } = props;
  return h(as, { ...rest, className: cx('rounded-lg border border-line bg-surface p-4 shadow-sm', className) }, children);
}

// -------------------------------------------------------------------------------------------------
// Pill (small status label)
// -------------------------------------------------------------------------------------------------

export type PillTone = 'neutral' | 'positive' | 'caution' | 'negative' | 'info';

const PILL_TONES: Record<PillTone, string> = {
  neutral: 'bg-surface-muted text-ink-muted',
  positive: 'bg-positive-50 text-positive-700',
  caution: 'bg-caution-50 text-caution-700',
  negative: 'bg-danger-50 text-danger-700',
  info: 'bg-brand-50 text-brand-700',
};

export interface PillProps {
  tone?: PillTone;
  className?: string;
  children?: ReactNode;
  title?: string;
}

export function Pill(props: PillProps): ReactNode {
  const { tone = 'neutral', className, children, title } = props;
  return h(
    'span',
    {
      title,
      className: cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm font-medium', PILL_TONES[tone], className),
    },
    children,
  );
}

// -------------------------------------------------------------------------------------------------
// Skeleton + VisuallyHidden
// -------------------------------------------------------------------------------------------------

export interface SkeletonProps {
  /** Fixed size classes are required so the real content does not shift layout (CLS budget). */
  className: string;
}

export function Skeleton(props: SkeletonProps): ReactNode {
  return h('span', { 'aria-hidden': true, className: cx('inline-block animate-pulse rounded bg-surface-muted', props.className) });
}

export function VisuallyHidden(props: { children?: ReactNode }): ReactNode {
  return h('span', { className: 'sr-only' }, props.children);
}

// -------------------------------------------------------------------------------------------------
// Icons — tiny inline SVGs (no icon font, no extra request)
// -------------------------------------------------------------------------------------------------

export type IconName =
  | 'home'
  | 'box'
  | 'globe'
  | 'search'
  | 'list'
  | 'shield'
  | 'book'
  | 'user'
  | 'more'
  | 'coin'
  | 'check'
  | 'cross'
  | 'question'
  | 'info';

const ICON_PATHS: Record<IconName, string> = {
  home: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
  box: 'M3 7l9-4 9 4-9 4-9-4zm0 0v10l9 4 9-4V7M12 11v10',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zm9 16l-4-4',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zm-3 9l2 2 4-4',
  book: 'M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2V5zm0 16a2 2 0 012-2h13',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9a8 8 0 0116 0',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  coin: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 4v10m-3-7h6',
  check: 'M5 12l5 5 9-10',
  cross: 'M6 6l12 12M18 6L6 18',
  question: 'M12 3a9 9 0 100 18 9 9 0 000-18zm-2.5 7a2.5 2.5 0 115 0c0 2-2.5 2-2.5 4m0 3h.01',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 8v6m0-9h.01',
};

export interface IconProps {
  name: IconName;
  className?: string;
}

export function Icon(props: IconProps): ReactNode {
  return h(
    'svg',
    {
      'aria-hidden': true,
      focusable: 'false',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: cx('h-5 w-5 shrink-0', props.className),
    },
    h('path', { d: ICON_PATHS[props.name] }),
  );
}
