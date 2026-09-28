/**
 * M28 — UI text for the credits & usage history page (message namespace `credits`).
 *
 * The English catalogue in apps/web/messages/en.json is owned by M04; until the `credits`
 * namespace is merged there, these English strings are the fallback. resolveCreditsLabels()
 * prefers the locale catalogue and falls back per key (same pattern as M13's HS helper labels),
 * so a Hindi catalogue (M51) can override any subset without M28 depending on M04's internals.
 */
import { getMessage, type Messages } from '../m04_ui/index.js';

export const CREDITS_NAMESPACE = 'credits';

export const CREDITS_MESSAGES_EN = Object.freeze({
  title: 'Credits',
  balanceAvailable: 'Available',
  balanceHeld: 'On hold',
  allowanceHeading: 'Free this month',
  allowanceRevealOne: '{count} contact reveal left',
  allowanceRevealOther: '{count} contact reveals left',
  allowanceCheckOne: '{count} buyer check left',
  allowanceCheckOther: '{count} buyer checks left',
  historyHeading: 'Usage history',
  historyEmpty: 'No activity yet.',
  loadMore: 'Load more',
  loading: 'Loading…',
  error: 'Something went wrong. Please try again.',
  signInRequired: 'Please sign in to see your credits and usage history.',
  signIn: 'Sign in',
  kindGrant: 'Free credits',
  kindTopup: 'Top-up',
  kindHold: 'Reserved',
  kindCommit: 'Spent',
  kindRelease: 'Released',
  kindRefund: 'Refunded',
  kindExpiry: 'Expired',
  kindAdjustment: 'Adjustment',
});

export type CreditsLabelKey = keyof typeof CREDITS_MESSAGES_EN;
export type CreditsLabels = Record<CreditsLabelKey, string>;

/** Builds the label set from a locale catalogue (null → English), falling back per key. */
export function resolveCreditsLabels(messages: Messages | null | undefined): CreditsLabels {
  const keys = Object.keys(CREDITS_MESSAGES_EN) as CreditsLabelKey[];
  const entries = keys.map((key): [CreditsLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${CREDITS_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? CREDITS_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as CreditsLabels;
}

/** Replaces `{name}` template variables; unknown variables are left as they are. */
export function fillLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}
