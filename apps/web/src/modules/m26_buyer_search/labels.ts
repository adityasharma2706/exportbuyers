/**
 * M26 — UI text for buyer search (message namespace `buyerSearch`).
 *
 * As with M13/M16, the English catalogue in apps/web/messages/en.json is owned by M04; until the
 * `buyerSearch` namespace is merged there, these English strings are the fallback.
 * resolveBuyerSearchLabels() prefers the locale catalogue per key. Template variables use `{name}`
 * and are filled with M13's fillLabel(). Coverage labels and the coverage disclaimer come from M04.
 */
import { getMessage, type Messages } from '../m04_ui/index.js';

export const BUYER_SEARCH_NAMESPACE = 'buyerSearch';

export const BUYER_SEARCH_MESSAGES_EN = Object.freeze({
  title: 'Find buyers',
  intro: 'Buyers who import {code}, ranked by relevance. Every result has gone through our suppression and sanctions checks.',
  noCode: 'Choose your product code first to search for buyers.',
  pickCode: 'Find your HS code',
  noCountries: 'Choose at least one country to search.',
  pickCountries: 'Pick countries',
  keywordLabel: 'Search by keyword',
  // Shown as persistent text below the field (wired to the input with aria-describedby) rather
  // than disappearing input-hint text, which reads poorly with some assistive tech.
  keywordHint: 'Company name, city, product…',
  searchButton: 'Search',
  searching: 'Searching…',
  sortLabel: 'Sort by',
  sortRelevance: 'Relevance',
  sortRecency: 'Most recently active',
  sortVolume: 'Shipment volume',
  sortTrust: 'Trust level',
  filtersHeading: 'Filters',
  filterCountries: 'Countries',
  filterType: 'Buyer type',
  filterRecency: 'Active within',
  filterRecency3: 'Last 3 months',
  filterRecency6: 'Last 6 months',
  filterRecency12: 'Last 12 months',
  filterRecencyAny: 'Any time',
  filterMinShipments: 'Minimum shipments (12 months)',
  filterTrust: 'Trust level',
  filterContact: 'Has contact type',
  filterOriginIndia: 'Sources from India',
  filterOriginCompetitor: "Sources from India's competitors",
  filterLogistics: 'Include logistics and freight companies',
  applyFilters: 'Apply filters',
  resultsHeading: '{count} buyers found',
  resultsHeadingOne: '1 buyer found',
  noResults: 'No buyers matched yet. Try fewer filters, or a broader product code.',
  lowConfidence: 'Lower confidence match',
  sanctionsWarning: 'Sanctions notice — view only',
  trustHigh: 'High trust',
  trustMedium: 'Medium trust',
  trustLow: 'Low trust',
  trustUnknown: 'Trust unknown',
  lastActivity: 'Last active {date}',
  lastActivityUnknown: 'No recent activity on record',
  evidenceHeading: 'Why we think this is a buyer',
  contactTypesNone: 'No contact details found yet',
  findingMore: 'Finding more buyers in {country}…',
  coverage: 'Buyer data',
  previewCount: '{count} buyers found in these countries.',
  previewNames: 'Including: {names}',
  previewNote: 'Sign up free to see full company details, evidence and contact availability.',
  planLimit: 'Showing {shown} of {total}. Upgrade to see more.',
  page: 'Page {page}',
  prevPage: 'Previous',
  nextPage: 'Next',
  rateLimited: 'You have reached the limit for visitors. Sign up to keep going, or try again in about {minutes} minutes.',
  challenge: 'Please complete the security check, then try again.',
  signUp: 'Sign up free',
  signInRequired: 'Please sign in again to search.',
  error: 'Something went wrong. Please try again.',
  retry: 'Try again',
  loading: 'Loading…',
});

export type BuyerSearchLabelKey = keyof typeof BUYER_SEARCH_MESSAGES_EN;
export type BuyerSearchLabels = Record<BuyerSearchLabelKey, string>;

/** Builds the label set from a locale catalogue (null → English), falling back per key. */
export function resolveBuyerSearchLabels(messages: Messages | null | undefined): BuyerSearchLabels {
  const keys = Object.keys(BUYER_SEARCH_MESSAGES_EN) as BuyerSearchLabelKey[];
  const entries = keys.map((key): [BuyerSearchLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${BUYER_SEARCH_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? BUYER_SEARCH_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as BuyerSearchLabels;
}

/**
 * Replaces `{name}` template variables; unknown variables are left as they are. M13 has the same
 * helper, but M26 does not depend on M13 (see docs/implementer.md), so this is its own copy
 * rather than an undeclared cross-module import.
 */
export function fillLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}
