/**
 * M39 — UI chrome text (message namespace `launchHardening`). Same fallback pattern as
 * M13/M28/M32/M37's labels.ts: prefers the locale catalogue (once merged into
 * apps/web/messages/*.json, owned by M04), falls back to this English default per key.
 */
import { getMessage, type Messages } from '../m04_ui/index.js';

export const LAUNCH_HARDENING_NAMESPACE = 'launchHardening';

export const LAUNCH_HARDENING_MESSAGES_EN = Object.freeze({
  dailyCapReached: 'You have reached today’s search limit. Try again tomorrow, or upgrade your plan for a higher limit.',
  challengeRequired: 'Please complete the challenge to keep searching.',
  challengeFailed: 'Challenge failed; please try again.',
  searchTryLater: 'We could not reach the buyer-discovery service. Please try again in a few minutes.',
});

export type LaunchHardeningLabelKey = keyof typeof LAUNCH_HARDENING_MESSAGES_EN;
export type LaunchHardeningLabels = Record<LaunchHardeningLabelKey, string>;

export function resolveLaunchHardeningLabels(messages: Messages | null | undefined): LaunchHardeningLabels {
  const keys = Object.keys(LAUNCH_HARDENING_MESSAGES_EN) as LaunchHardeningLabelKey[];
  const entries = keys.map((key): [LaunchHardeningLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${LAUNCH_HARDENING_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? LAUNCH_HARDENING_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as LaunchHardeningLabels;
}
