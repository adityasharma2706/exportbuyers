/**
 * M16 — UI text for the Market Finder (message namespace `marketFinder`).
 *
 * As with M13, the English catalogue in apps/web/messages/en.json is owned by M04; until the
 * `marketFinder` namespace is merged there, these English strings are the fallback.
 * resolveMarketFinderLabels() prefers the locale catalogue per key. Template variables use `{name}`
 * and are filled with M13's fillLabel(). Coverage labels and the coverage disclaimer come from M04.
 */
import { getMessage, type Messages } from '../m04_ui/index.js';

export const MARKET_FINDER_NAMESPACE = 'marketFinder';

export const MARKET_FINDER_MESSAGES_EN = Object.freeze({
  title: 'Where to sell {code}',
  intro: 'Countries ranked by how much they import, how fast imports are growing and how much room there is for Indian suppliers.',
  dataYear: 'Trade data for {year} (UN Comtrade).',
  loading: 'Loading markets…',
  rankLabel: '#{rank}',
  importValue: 'Imports',
  importValueValue: '{value} a year',
  growth: 'Growth',
  growthValue: '{pct}% a year (5 years)',
  growthUnknown: 'Not known',
  indiaShare: "India's share",
  indiaShareValue: '{pct}%',
  indiaShareUnknown: 'Not known',
  suppliers: 'Main competing suppliers',
  suppliersNone: 'Not known',
  supplierItem: '{country} ({pct}%)',
  fta: 'Trade agreement',
  ftaValue: '{agreement}, in force since {date}',
  ftaNone: 'No trade agreement with India on record',
  ftaSource: 'Source',
  coverage: 'Buyer data',
  why: 'Why this market',
  whyPending: 'A short summary is being prepared.',
  whyTemplate: '{country} imported about US${value} million of {code} in {year}.',
  whyTemplateGrowth: 'Imports grew about {pct}% a year over the last five years.',
  whyTemplateShare: 'India supplies about {pct}% of them today.',
  shortlist: 'Shortlist {country}',
  shortlisted: '{count} countries shortlisted',
  shortlistNone: 'Pick the countries you want to sell to. They become the default countries for your buyer search.',
  saveShortlist: 'Save shortlist',
  saving: 'Saving…',
  saved: 'Saved. Buyer search will start with these countries.',
  savedAnon: 'Saved for this visit. Sign up to find buyers in these countries.',
  savedNotPersisted: 'Selected for this visit only. Sign up to keep your shortlist.',
  findBuyers: 'Find buyers',
  noRowsTryParent: 'We have no trade figures for {code}. Try the broader 4-digit heading {parent}.',
  tryParent: 'Show {parent}',
  noRows: 'We have no trade figures for {code} yet.',
  noCode: 'Choose your product code first to see markets.',
  pickCode: 'Find your HS code',
  invalidCode: 'Market ranking needs a 4, 6 or 8 digit HS code.',
  tooManyCountries: 'You have picked too many countries. Remove some and save again.',
  rateLimited: 'You have reached the limit for visitors. Sign up to keep going, or try again in about {minutes} minutes.',
  challenge: 'Please complete the security check, then try again.',
  signUp: 'Sign up free',
  signInRequired: 'Please sign in again to save your shortlist.',
  error: 'Something went wrong. Please try again.',
  retry: 'Try again',
});

export type MarketFinderLabelKey = keyof typeof MARKET_FINDER_MESSAGES_EN;
export type MarketFinderLabels = Record<MarketFinderLabelKey, string>;

/** Builds the label set from a locale catalogue (null → English), falling back per key. */
export function resolveMarketFinderLabels(messages: Messages | null | undefined): MarketFinderLabels {
  const keys = Object.keys(MARKET_FINDER_MESSAGES_EN) as MarketFinderLabelKey[];
  const entries = keys.map((key): [MarketFinderLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${MARKET_FINDER_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? MARKET_FINDER_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as MarketFinderLabels;
}
