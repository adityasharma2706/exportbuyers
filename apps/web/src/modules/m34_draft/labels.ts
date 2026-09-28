/**
 * M34 — UI text for the draft composer (message namespace `draft`). Same fallback pattern as
 * M13/M26/M28/M32's labels.ts: prefers the locale catalogue, falls back per key.
 */
import { getMessage, type Messages } from '../m04_ui/index.js';

export const DRAFT_NAMESPACE = 'draft';

export const DRAFT_MESSAGES_EN = Object.freeze({
  title: 'Draft a message',
  toneLabel: 'Tone',
  toneFormal: 'Formal',
  toneFriendly: 'Friendly',
  languageLabel: 'Language',
  generate: 'Draft message',
  generating: 'Writing…',
  regenerate: 'Draft again',
  editableHint: 'Feel free to edit the message before you send it.',
  footerHint: 'This closing is added automatically and always sent as written.',
  copy: 'Copy message',
  copied: 'Copied',
  mailto: 'Open in email',
  whatsapp: 'Open in WhatsApp',
  savedHint: 'Your edits are saved automatically.',
  errorGeneric: 'Something went wrong while drafting this message. Please try again.',
  errorRateLimited: "You've reached today's drafting limit. Please try again tomorrow.",
  errorSanctions: 'A draft cannot be created for this company.',
  errorIncompleteProfile: 'Add your name and business details to your profile before drafting a message.',
  goToProfile: 'Complete your profile',
});

export type DraftLabelKey = keyof typeof DRAFT_MESSAGES_EN;
export type DraftLabels = Record<DraftLabelKey, string>;

export function resolveDraftLabels(messages: Messages | null | undefined): DraftLabels {
  const keys = Object.keys(DRAFT_MESSAGES_EN) as DraftLabelKey[];
  const entries = keys.map((key): [DraftLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${DRAFT_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? DRAFT_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as DraftLabels;
}
