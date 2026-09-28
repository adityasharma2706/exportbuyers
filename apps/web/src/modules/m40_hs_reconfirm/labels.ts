/**
 * M40 — UI text for the HS re-confirmation banner (message namespace `hsReconfirm`).
 *
 * The English catalogue in apps/web/messages/en.json is owned by M04; until the `hsReconfirm`
 * namespace is merged there, these English strings are the fallback, the same pattern as M13's
 * `hsHelper` namespace. Template variables use `{name}` and are filled with `fillLabel()`.
 */
import { getMessage, type Messages } from '../m04_ui/index.js';
import { fillLabel } from '../m13_hs_helper/index.js';

export { fillLabel };

export const HS_RECONFIRM_NAMESPACE = 'hsReconfirm';

export const HS_RECONFIRM_MESSAGES_EN = Object.freeze({
  bannerTitle: 'The HS code list has changed',
  bannerIntroOne: 'The official nomenclature moved to {newVersion}. One of your products needs its HS code re-confirmed so your searches and drafts keep matching the right buyers.',
  bannerIntroOther:
    'The official nomenclature moved to {newVersion}. {count} of your products need their HS code re-confirmed so your searches and drafts keep matching the right buyers.',
  oldCodeLabel: 'Current code: {code}',
  possibleMatches: 'Possible matches in {newVersion}',
  relationOneToOne: 'Likely the same product line',
  relationOneToMany: 'This code was split into several; pick the one that matches',
  relationManyToOne: 'Several old codes were merged into this one',
  relationManyToMany: 'The code list was reorganised here; check the description',
  confirmCode: 'Confirm {code}',
  confirming: 'Saving…',
  confirmed: 'Confirmed {code} ({version}).',
  noMatches: 'We could not automatically match this code. Search for the new one below.',
  searchInstead: 'Search for the new code',
  hideSearch: 'Hide search',
  error: 'Something went wrong. Please try again.',
  notPending: 'This product has already been re-confirmed.',
  loading: 'Loading…',
  dismiss: 'Dismiss',
});

export type HsReconfirmLabelKey = keyof typeof HS_RECONFIRM_MESSAGES_EN;
export type HsReconfirmLabels = Record<HsReconfirmLabelKey, string>;

/** Builds the label set from a locale catalogue (null -> English), falling back per key. */
export function resolveHsReconfirmLabels(messages: Messages | null | undefined): HsReconfirmLabels {
  const keys = Object.keys(HS_RECONFIRM_MESSAGES_EN) as HsReconfirmLabelKey[];
  const entries = keys.map((key): [HsReconfirmLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${HS_RECONFIRM_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? HS_RECONFIRM_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as HsReconfirmLabels;
}
