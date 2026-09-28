/**
 * M31 — UI text for the public removal/correction form and its verification landing page
 * (message namespace `removal`).
 *
 * The English catalogue in apps/web/messages/en.json is owned by M04; until the `removal`
 * namespace is merged there, these English strings are the fallback, same pattern as M13's
 * hsHelper labels (see m13_hs_helper/labels.ts).
 */
import { getMessage, type Messages } from '../m04_ui/index.js';

export const REMOVAL_NAMESPACE = 'removal';

export const REMOVAL_MESSAGES_EN = Object.freeze({
  title: 'Request removal or a correction',
  intro:
    'If your company appears in our buyer directory and you want it removed, or a detail is wrong, tell us below. ' +
    'We will email you a link to confirm the request before we act on it.',
  kindLabel: 'What do you need?',
  kindRemoval: 'Remove my company from the directory',
  kindCorrection: 'Correct a detail about my company',
  requesterEmailLabel: 'Your email address',
  requesterEmailHint: 'We send a confirmation link here before anything changes. Use an address at your company domain if you can.',
  identifiersHeading: 'Tell us which listing this is',
  identifiersHint: 'Fill in whichever of these you know; at least one is required.',
  domainLabel: 'Company website domain',
  emailLabel: 'A contact email shown for the company',
  phoneLabel: 'A phone number shown for the company',
  companyNameLabel: 'Company name',
  countryLabel: 'Country',
  detailsLabel: 'Details',
  detailsHintRemoval: 'Optional: anything that helps us find and verify the listing.',
  detailsHintCorrection: 'Required: tell us exactly what is wrong and what it should say instead.',
  submitButton: 'Send verification email',
  submitting: 'Sending…',
  success: 'Check your email for a link to confirm this request. It is valid for {ttlHours} hours.',
  validationIdentifiers: 'Fill in at least one of the fields above so we can find the listing.',
  validationEmail: 'Enter a valid email address.',
  validationDetails: 'Please describe what needs correcting.',
  rateLimited: 'Too many requests from this device. Please try again in about {minutes} minutes.',
  challenge: 'Please complete the security check, then try again.',
  error: 'Something went wrong. Please try again.',
  verifyingTitle: 'Confirming your request…',
  verifyingBody: 'One moment while we file your request.',
  verifiedTitle: 'Request received',
  verifiedBody: 'Thank you. Our team will review this within a few days and email you the outcome.',
  alreadyProcessedBody: 'This request was already confirmed; no further action is needed.',
  invalidTokenTitle: 'This link is invalid or has expired',
  invalidTokenBody: 'Please go back to the removal and correction form and submit your request again.',
  backToForm: 'Back to the form',
  backHome: 'Back to home',
});

export type RemovalLabelKey = keyof typeof REMOVAL_MESSAGES_EN;
export type RemovalLabels = Record<RemovalLabelKey, string>;

/** Builds the label set from a locale catalogue (null -> English), falling back per key. */
export function resolveRemovalLabels(messages: Messages | null | undefined): RemovalLabels {
  const keys = Object.keys(REMOVAL_MESSAGES_EN) as RemovalLabelKey[];
  const entries = keys.map((key): [RemovalLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${REMOVAL_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? REMOVAL_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as RemovalLabels;
}

/** Replaces `{name}` template variables; unknown variables are left as they are. */
export function fillLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}
