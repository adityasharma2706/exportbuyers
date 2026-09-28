/**
 * M42 — UI text for the follow-up composer (message namespace `followUp`). Same fallback pattern
 * as M34/M13/M26/M28/M32's labels.ts: prefers the locale catalogue, falls back per key.
 */
import { getMessage, type Messages } from '../m04_ui/index.js';

export const FOLLOW_UP_NAMESPACE = 'followUp';

export const FOLLOW_UP_MESSAGES_EN = Object.freeze({
  title: 'Draft a follow-up',
  toneLabel: 'Tone',
  toneFormal: 'Formal',
  toneFriendly: 'Friendly',
  languageLabel: 'Language',
  generate: 'Draft follow-up',
  generating: 'Writing…',
  regenerate: 'Draft again',
  editableHint: 'Feel free to edit the message before you send it.',
  footerHint: 'This closing is added automatically and always sent as written.',
  copy: 'Copy message',
  copied: 'Copied',
  mailto: 'Open in email',
  savedHint: 'Your edits are saved automatically.',
  errorGeneric: 'Something went wrong while drafting this message. Please try again.',
  errorRateLimited: "You've reached today's drafting limit. Please try again tomorrow.",
  errorSanctions: 'A draft cannot be created for this company.',
  errorIncompleteProfile: 'Add your name and business details to your profile before drafting a message.',
  errorReplied: 'This buyer has already replied, so no further follow-up is needed.',
  errorMaxFollowUps: 'This thread already has its second follow-up; no more are allowed.',
  goToProfile: 'Complete your profile',
});

export type FollowUpLabelKey = keyof typeof FOLLOW_UP_MESSAGES_EN;
export type FollowUpLabels = Record<FollowUpLabelKey, string>;

export function resolveFollowUpLabels(messages: Messages | null | undefined): FollowUpLabels {
  const keys = Object.keys(FOLLOW_UP_MESSAGES_EN) as FollowUpLabelKey[];
  const entries = keys.map((key): [FollowUpLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${FOLLOW_UP_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? FOLLOW_UP_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as FollowUpLabels;
}
