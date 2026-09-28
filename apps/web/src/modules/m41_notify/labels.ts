/**
 * M41 — display labels for the notification title keys this module itself emits. Pure lookup,
 * no I/O: kept separate from M37's content store (not one of this module's declared deps), the
 * same reasoning M33's labels.ts gives for shortlist statuses.
 */
import { NOTIFY_TITLE_KEY_REMINDER_DUE } from './types.js';

export const NOTIFY_LABELS_EN: Readonly<Record<string, string>> = Object.freeze({
  [NOTIFY_TITLE_KEY_REMINDER_DUE]: 'A follow-up you scheduled is due',
});

/** Falls back to the raw key when a caller supplies a titleKey this module does not itself own
 * (M42/M45/M20/M31 each mint their own keys), so the UI always has something to render. */
export function notifyTitleLabel(titleKey: string, locale: 'en' | 'hi' = 'en'): string {
  // Hindi copy is reviewed content owned by M37; until it lands, English is the honest fallback.
  void locale;
  return NOTIFY_LABELS_EN[titleKey] ?? titleKey;
}
