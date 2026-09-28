/**
 * M37 — UI chrome text for content pages (message namespace `content`). Same fallback pattern as
 * M13/M28/M32's labels.ts: prefers the locale catalogue (once the namespace is merged into
 * apps/web/messages/*.json, owned by M04), falls back to this English default per key. The page
 * *body* text itself is never a literal here — it always comes from the Markdown content tree via
 * IF-37a `getPage`/`listBySection`.
 */
import { getMessage, type Messages } from '../m04_ui/index.js';

export const CONTENT_NAMESPACE = 'content';

export const CONTENT_MESSAGES_EN = Object.freeze({
  breadcrumbHome: 'Home',
  learnLabel: 'Learn',
  glossaryLabel: 'Glossary',
  scamRedFlagsLabel: 'Spot a scam',
  checklistLabel: 'First export checklist',
  promiseLabel: 'What we promise',
  coverageLabel: 'Coverage policy',
  refundPolicyLabel: 'Refund policy',
  pricingLabel: 'Pricing',
  lastUpdated: 'Last updated {date}',
  reviewedOn: 'Reviewed {date}',
  localeFallbackNote: 'Shown in English — not yet translated for this language.',
  onThisSection: 'In this section',
  relatedGuides: 'Related guides',
  moreInLearn: 'More in Learn',
  readGuide: 'Read guide',
  backToLearn: 'Back to Learn',
  backToScamGuide: 'Back to scam red flags',
  notFoundTitle: 'Page not found',
  notFoundBody: 'This page does not exist yet, or has moved. Try the Learn area instead.',
  emptySection: 'Nothing published in this section yet.',
  glossaryIntro: 'Plain-English definitions of the export terms you will see across this site. Tap any underlined term where you see it for a quick definition.',
  scamIntro: 'Common patterns behind buyer scams. If a message you received matches one of these, treat it as a strong warning sign and run it through Check a buyer before you reply.',
  checkBuyerCta: 'Check a buyer now',
  hsChapterLinksHeading: 'Official resources for this product',
  hsChapterLinksEmpty: 'We do not have official links mapped for this HS chapter yet. DGFT Trade Connect covers every product.',
});

export type ContentLabelKey = keyof typeof CONTENT_MESSAGES_EN;
export type ContentLabels = Record<ContentLabelKey, string>;

export function resolveContentLabels(messages: Messages | null | undefined): ContentLabels {
  const keys = Object.keys(CONTENT_MESSAGES_EN) as ContentLabelKey[];
  const entries = keys.map((key): [ContentLabelKey, string] => {
    const translated = messages ? getMessage(messages, `${CONTENT_NAMESPACE}.${key}`) : undefined;
    return [key, translated ?? CONTENT_MESSAGES_EN[key]];
  });
  return Object.fromEntries(entries) as ContentLabels;
}

/** Replaces `{name}` template variables; unknown variables are left as they are. */
export function fillLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}
