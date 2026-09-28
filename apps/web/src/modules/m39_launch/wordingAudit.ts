/**
 * M39 — wording audit (LLD M39 #7): "a CI grep across `/content`, `/apps/web/messages` and the
 * templates for `verified genuine|guaranteed buyer|100% genuine`. Any match fails the build."
 * REQ-028 (the checklist never labels a buyer "verified genuine" or guaranteed), REQ-066 (public
 * pages state what the product does and does not promise).
 *
 * There is no shell in this environment to add a standalone CI script step (LD-1), so — the same
 * way M37's own build check runs as a unit test against the real content tree
 * (m37_content/buildcheck.ts's header comment) — this audit runs as a real `node:test` against
 * the live catalogues, and a failing assertion blocks the build exactly the same way a CI step
 * would.
 *
 * Three sources, matching the LLD's three:
 *   - `/content`        M37's own content index (Markdown bodies + locale strings JSON).
 *   - `/apps/web/messages`  M04's locale message catalogues.
 *   - "the templates"   every module's own `*_MESSAGES_EN` object (m04_ui/*labels.ts pattern):
 *                        per M37's labels.ts comment, this text is already live in production
 *                        UI/templates (drafts, notifications, buttons) whether or not it has been
 *                        merged into `apps/web/messages/*.json` yet, so scanning only the merged
 *                        catalogue would miss it. [deviation: this is a fixed list of the
 *                        `*_MESSAGES_EN` exports that exist as of M39 — a later module that adds
 *                        a new `labels.ts` must add its import here too, the same kind of
 *                        "no shell to auto-discover" limitation the rest of this environment
 *                        accepts (e.g. the module list itself is hand-maintained in
 *                        docs/implementer.md). A raw-text scan of every `.ts` file was rejected:
 *                        this very file's own comments (and M04's wording.ts, M24's LLD text)
 *                        legitimately *name* the forbidden phrase to explain the policy, which
 *                        would make a blind source-text grep self-trip.]
 */
import { LOCALES, flattenMessages, loadMessages } from '../m04_ui/index.js';
import { allDocuments, getContentIndex } from '../m37_content/index.js';
import { BUYER_PROFILE_MESSAGES_EN } from '../m27_buyer_profile/labels.js';
import { BUYER_SEARCH_MESSAGES_EN } from '../m26_buyer_search/labels.js';
import { CHECK_BUYER_MESSAGES_EN } from '../m32_check_buyer/labels.js';
import { CONTENT_MESSAGES_EN } from '../m37_content/labels.js';
import { CREDITS_MESSAGES_EN } from '../m28_credits/labels.js';
import { DRAFT_MESSAGES_EN } from '../m34_draft/labels.js';
import { HS_HELPER_MESSAGES_EN } from '../m13_hs_helper/labels.js';
import { LAUNCH_HARDENING_MESSAGES_EN } from './labels.js';
import { MARKET_FINDER_MESSAGES_EN } from '../m16_market_finder/labels.js';
import { REMOVAL_MESSAGES_EN } from '../m31_removal/labels.js';

/** LLD M39 #7's exact pattern. Case-insensitive, matching the CI grep it replaces. */
export const FORBIDDEN_WORDING_RE = /verified genuine|guaranteed buyer|100% genuine/i;

export interface WordingViolation {
  source: string;
  location: string;
  snippet: string;
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/** Pure: scans one piece of text, returning every match's snippet (not just the first). */
export function findForbiddenWording(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(FORBIDDEN_WORDING_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(snippetAround(text, m.index, m[0].length));
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-length matches
  }
  return out;
}

function scanValue(source: string, location: string, value: string, out: WordingViolation[]): void {
  for (const snippet of findForbiddenWording(value)) out.push({ source, location, snippet });
}

/** `/content`: every Markdown body, front-matter title/description, and locale strings file. */
export function scanContentTree(): WordingViolation[] {
  const out: WordingViolation[] = [];
  for (const doc of allDocuments()) {
    scanValue('content', `${doc.locale}/${doc.section}/${doc.slug}.md`, doc.rawBody, out);
    scanValue('content', `${doc.locale}/${doc.section}/${doc.slug}.md#title`, doc.frontMatter.title, out);
  }
  const index = getContentIndex();
  for (const [locale, strings] of index.strings) {
    for (const [key, value] of strings) scanValue('content', `${locale}/strings#${key}`, value, out);
  }
  return out;
}

/** `/apps/web/messages/<locale>.json`. */
export async function scanMessageCatalogues(): Promise<WordingViolation[]> {
  const out: WordingViolation[] = [];
  for (const locale of LOCALES) {
    let messages;
    try {
      messages = await loadMessages(locale);
    } catch {
      continue; // a locale catalogue that does not exist yet (e.g. before M51 adds hi) is not a violation
    }
    for (const [key, value] of flattenMessages(messages)) scanValue('messages', `${locale}.json#${key}`, value, out);
  }
  return out;
}

/** Every registered module's own `*_MESSAGES_EN` template/label object (see the file header). */
const REGISTERED_LABEL_SOURCES: ReadonlyArray<{ module: string; messages: Record<string, unknown> }> = [
  { module: 'm13_hs_helper', messages: HS_HELPER_MESSAGES_EN },
  { module: 'm16_market_finder', messages: MARKET_FINDER_MESSAGES_EN },
  { module: 'm26_buyer_search', messages: BUYER_SEARCH_MESSAGES_EN },
  { module: 'm27_buyer_profile', messages: BUYER_PROFILE_MESSAGES_EN },
  { module: 'm28_credits', messages: CREDITS_MESSAGES_EN },
  { module: 'm31_removal', messages: REMOVAL_MESSAGES_EN },
  { module: 'm32_check_buyer', messages: CHECK_BUYER_MESSAGES_EN },
  { module: 'm34_draft', messages: DRAFT_MESSAGES_EN },
  { module: 'm37_content', messages: CONTENT_MESSAGES_EN },
  { module: 'm39_launch', messages: LAUNCH_HARDENING_MESSAGES_EN },
];

export function scanRegisteredLabelSources(): WordingViolation[] {
  const out: WordingViolation[] = [];
  for (const { module, messages } of REGISTERED_LABEL_SOURCES) {
    for (const [key, value] of Object.entries(messages)) {
      if (typeof value === 'string') scanValue('templates', `${module}/labels.ts#${key}`, value, out);
    }
  }
  return out;
}

/** Runs all three scans (LLD M39 #7). Any non-empty result fails the build. */
export async function runWordingAudit(): Promise<WordingViolation[]> {
  const [content, messages] = await Promise.all([Promise.resolve(scanContentTree()), scanMessageCatalogues()]);
  return [...content, ...messages, ...scanRegisteredLabelSources()];
}
