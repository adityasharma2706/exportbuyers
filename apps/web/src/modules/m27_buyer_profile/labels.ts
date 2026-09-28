/**
 * M27 — UI text for the buyer profile page (message namespace `buyerProfile`).
 *
 * As with M13/M16/M26, the English catalogue in apps/web/messages/en.json is owned by M04; until
 * the `buyerProfile` namespace is merged there, these English strings are the fallback.
 * `resolveBuyerProfileLabels()` prefers the locale catalogue per key. `fillLabel` fills `{name}`
 * template variables (own copy, matching M26 — M27 does not depend on M13).
 */
import { getMessage, type Messages } from '../m04_ui/index.js';

export const BUYER_PROFILE_NAMESPACE = 'buyerProfile';

export const BUYER_PROFILE_MESSAGES_EN = Object.freeze({
  backToSearch: 'Back to search',
  overviewHeading: 'Overview',
  statusClosed: 'This company appears closed',
  buyerTypeUnknown: 'Buyer type not yet classified',
  websiteHeading: 'Website',
  websiteNone: 'No website on record',
  evidenceHeading: 'Why we think this is a buyer',
  evidenceNone: 'No product evidence recorded yet.',
  evidenceSnippetFallback: 'Evidence recorded, no detail available',
  evidenceCheckedOn: 'Checked {date}',
  evidenceObservedOn: 'Seen {date}',
  activityHeading: 'Activity and shipments',
  activityNone: 'No shipment activity data available for this product yet.',
  activityShipments: '{count} shipments in the last 12 months',
  activityVolume: '{volume} kg in the last 12 months',
  activityLastSeen: 'Last shipment seen {date}',
  activityOrigins: 'Main supplier countries: {list}',
  sourcingHeading: 'Sourcing from India and competitors',
  sourcingIndiaYes: 'Already sources this product from India',
  sourcingIndiaNo: 'Does not currently source this product from India',
  sourcingIndiaUnknown: 'No shipment data available to tell whether this buyer sources from India',
  sourcingCompetitorYes: "Sources this product from India's competitors",
  sourcingCompetitorNo: "Does not source this product from India's competitors, as far as we can tell",
  sourcingCompetitorUnknown: 'No shipment data available on competitor sourcing',
  sanctionsWarningHeading: 'Sanctions notice',
  sanctionsWarningBody: 'This company matches a sanctions or denied-party list. Contact reveal and outreach drafting are turned off.',
  contactsHeading: 'Contacts',
  contactsNone: 'No contact details found yet.',
  contactsRevealed: 'Contacts revealed',
  revealButton: 'Reveal contacts',
  revealing: 'Revealing…',
  revealBlocked: 'Contact reveal is not available for this company right now.',
  draftButton: 'Draft outreach',
  draftBlocked: 'Outreach drafting is not available for this company right now.',
  actionBlockedSanctions: 'Turned off: this company matches a sanctions or denied-party list.',
  actionBlockedClosed: 'Turned off: this company appears closed.',
  actionBlockedPlanLimit: 'Not included in your current plan.',
  actionBlockedLicence: 'Not available under the current data licence.',
  actionBlockedRegion: 'Not available in your region.',
  actionBlockedOther: 'Not available right now.',
  redFlagsHeading: 'Things to check before you reach out',
  notesHeading: 'Notes and status',
  notesNone: 'No notes yet. Notes and pipeline status arrive with My buyers.',
  draftsHeading: 'Outreach drafts',
  draftsNone: 'No drafts yet.',
  notFound: 'This buyer could not be found.',
  notFoundUnhideHint: "You've hidden this company. ",
  unhideLink: 'Unhide it',
  signInRequired: 'Please sign in to view buyer profiles.',
  redirected: 'This company record was merged; showing the current version.',
  loading: 'Loading…',
  error: 'Something went wrong. Please try again.',
  retry: 'Try again',
});

export type BuyerProfileLabelKey = keyof typeof BUYER_PROFILE_MESSAGES_EN;
export type BuyerProfileLabels = Record<BuyerProfileLabelKey, string>;

/** Builds the label set from a locale catalogue (null → English), falling back per key. */
export function resolveBuyerProfileLabels(messages: Messages | null | undefined): BuyerProfileLabels {
  const keys = Object.keys(BUYER_PROFILE_MESSAGES_EN) as BuyerProfileLabelKey[];
  const entries = keys.map((key): [BuyerProfileLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${BUYER_PROFILE_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? BUYER_PROFILE_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as BuyerProfileLabels;
}

/** Replaces `{name}` template variables; unknown variables are left as they are. */
export function fillLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}

/** Maps a `ProfileActionDto.explanationKey` (built by dto.ts) to a label. Unknown keys fall back
 * to `actionBlockedOther`, never a raw key. */
export function actionBlockedLabel(labels: BuyerProfileLabels, explanationKey: string | undefined): string {
  switch (explanationKey) {
    case 'buyerProfile.action.blocked.sanctions':
      return labels.actionBlockedSanctions;
    case 'buyerProfile.action.blocked.closed':
      return labels.actionBlockedClosed;
    case 'buyerProfile.action.blocked.planLimit':
      return labels.actionBlockedPlanLimit;
    case 'buyerProfile.action.blocked.licence':
      return labels.actionBlockedLicence;
    case 'buyerProfile.action.blocked.region':
      return labels.actionBlockedRegion;
    default:
      return labels.actionBlockedOther;
  }
}
