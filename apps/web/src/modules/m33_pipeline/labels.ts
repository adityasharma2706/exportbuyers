/**
 * M33 — display labels for shortlist statuses (LLD M33: "Statuses: To contact, Contacted,
 * Replied, In discussion, Sample sent, Order won, Not interested"). Pure lookup, no I/O: kept
 * separate from M37's content store (not one of this module's declared deps) so the "My buyers"
 * UI has plain-English labels to render immediately.
 */
import type { ShortlistStatus } from './types.js';

export const STATUS_LABELS_EN: Readonly<Record<ShortlistStatus, string>> = Object.freeze({
  to_contact: 'To contact',
  contacted: 'Contacted',
  replied: 'Replied',
  in_discussion: 'In discussion',
  sample_sent: 'Sample sent',
  order_won: 'Order won',
  not_interested: 'Not interested',
});

export function statusLabel(status: ShortlistStatus, locale: 'en' | 'hi' = 'en'): string {
  // Hindi copy is reviewed content owned by M37; until it lands, English is the honest fallback.
  void locale;
  return STATUS_LABELS_EN[status];
}
