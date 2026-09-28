/**
 * M32 — UI text for the standalone "Check a buyer" tool (message namespace `checkBuyer`). Same
 * fallback pattern as M13/M26/M28's labels.ts: prefers the locale catalogue, falls back per key.
 */
import { getMessage, type Messages } from '../m04_ui/index.js';

export const CHECK_BUYER_NAMESPACE = 'checkBuyer';

export const CHECK_BUYER_MESSAGES_EN = Object.freeze({
  title: 'Check a buyer',
  intro: "Before you reach out, run a quick check on a company you don't know yet.",
  nameLabel: 'Company name',
  emailLabel: 'Email address',
  websiteLabel: 'Website',
  countryLabel: 'Country',
  messageLabel: 'Paste their message (optional)',
  messageHelp: "If you have an email or message from them, paste it here — it helps spot scam patterns like advance-fee requests.",
  submit: 'Check this buyer',
  checking: 'Checking…',
  needOne: 'Enter at least a company name, email or website.',
  resultHeading: 'Result',
  redFlagsHeading: 'Things to watch out for',
  noRedFlags: 'No known scam patterns were found in what you entered.',
  matchedHeading: 'Good news',
  matchedBody: 'This looks like a company already in our buyer database — open its full profile for more detail.',
  viewProfile: 'View full profile',
  adviceHeading: 'What to do next',
  sanctionsClear: 'No sanctions match found.',
  sanctionsPossible: 'Possible sanctions/denied-party match — verify carefully before proceeding.',
  sanctionsHit: 'This name matches a sanctions or denied-party list. Do not proceed without compliance review.',
  sanctionsUnknown: 'Sanctions screening was unavailable for this check.',
  freeLeft: '{count} free checks left this month',
  costNotice: 'This check will use {credits} credit(s).',
  error: 'Something went wrong. Please try again.',
  rateLimited: 'Too many checks from this device. Please try again later, or sign up for more.',
  signUp: 'Sign up',
  disclaimer: 'This is an automated check, not legal or professional advice. It cannot confirm that a company is safe to trade with — always do your own diligence.',
});

export type CheckBuyerLabelKey = keyof typeof CHECK_BUYER_MESSAGES_EN;
export type CheckBuyerLabels = Record<CheckBuyerLabelKey, string>;

export function resolveCheckBuyerLabels(messages: Messages | null | undefined): CheckBuyerLabels {
  const keys = Object.keys(CHECK_BUYER_MESSAGES_EN) as CheckBuyerLabelKey[];
  const entries = keys.map((key): [CheckBuyerLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${CHECK_BUYER_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? CHECK_BUYER_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as CheckBuyerLabels;
}

/** Replaces `{name}` template variables; unknown variables are left as they are. */
export function fillLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}
