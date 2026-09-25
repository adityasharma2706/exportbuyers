/**
 * M13 — UI text for the HS helper (message namespace `hsHelper`).
 *
 * The English catalogue in apps/web/messages/en.json is owned by M04; until the `hsHelper`
 * namespace is merged there, these English strings are the fallback. resolveHsHelperLabels()
 * prefers the locale catalogue and falls back per key, so a Hindi catalogue (M51) can override
 * any subset. Template variables use `{name}` and are filled with fillLabel().
 */
import { getMessage, type Messages } from '../m04_ui/index.js';

export const HS_HELPER_NAMESPACE = 'hsHelper';

export const HS_HELPER_MESSAGES_EN = Object.freeze({
  title: 'Find your HS code',
  intro: 'Describe your product in your own words. We suggest matching codes and show the export policy for 8-digit ITC-HS lines.',
  describeLabel: 'What do you make?',
  describeExample:'For example: cotton bath towels, hand-woven',
  describeHint: 'Between 3 and 300 characters. Do not include phone numbers or email addresses.',
  suggestButton: 'Suggest codes',
  suggesting: 'Finding codes…',
  resultsHeading: 'Suggested codes',
  noResults: 'We could not find a confident match. Browse the code list or enter a code you know.',
  degradedNote: 'Our AI ranking is unavailable right now, so these are the closest text matches without explanations.',
  confidence: '{pct}% match',
  levelChapter: 'Chapter',
  levelHeading: '4-digit heading',
  levelSubheading: '6-digit HS subheading',
  levelNational8: '8-digit ITC-HS line',
  versionLabel: 'Nomenclature: {version}',
  policyLabel: 'Export policy',
  policyFree: 'Free to export',
  policyRestricted: 'Restricted: licence or conditions apply',
  policyProhibited: 'Prohibited for export',
  policySte: 'Export only through a state trading enterprise',
  policyUnknown: 'Policy not available',
  policyLink: 'Official DGFT policy',
  policyConfirm: 'Always confirm the export policy with DGFT or your customs broker (CHA) before you ship.',
  pick8Digit: 'Pick an 8-digit ITC-HS code to see its export policy.',
  useCode: 'Use this code',
  saving: 'Saving…',
  saved: 'Saved {code} ({version}).',
  savedAnon: 'Saved {code} ({version}). Sign up to keep it in a product workspace.',
  savedNotPersisted: 'Code {code} ({version}) selected for this visit. Sign up to keep it.',
  directHeading: 'Already know your code?',
  directLabel: 'HS or ITC-HS code (4, 6 or 8 digits)',
  directButton: 'Look up',
  notFound: 'We could not find code {code}.',
  invalidCode: 'Enter a code with 4, 6 or 8 digits.',
  invalidText: 'Please describe your product in 3 to 300 characters, without contact details.',
  browseHeading: 'Browse the code list',
  browseButton: 'Browse codes',
  browseRoot: 'All chapters',
  browseOpen: 'Open {code}',
  browseEmpty: 'There are no further lines under this code.',
  breadcrumb: 'Where you are in the code list',
  rateLimited: 'You have reached the limit for visitors. Sign up to keep going, or try again in about {minutes} minutes.',
  challenge: 'Please complete the security check, then try again.',
  signUp: 'Sign up free',
  signInRequired: 'Please sign in again to save this code.',
  error: 'Something went wrong. Please try again.',
  loading: 'Loading…',
});

export type HsHelperLabelKey = keyof typeof HS_HELPER_MESSAGES_EN;
export type HsHelperLabels = Record<HsHelperLabelKey, string>;

/** Builds the label set from a locale catalogue (null → English), falling back per key. */
export function resolveHsHelperLabels(messages: Messages | null | undefined): HsHelperLabels {
  const keys = Object.keys(HS_HELPER_MESSAGES_EN) as HsHelperLabelKey[];
  const entries = keys.map((key): [HsHelperLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${HS_HELPER_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? HS_HELPER_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as HsHelperLabels;
}

/** Replaces `{name}` template variables; unknown variables are left as they are. */
export function fillLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}
