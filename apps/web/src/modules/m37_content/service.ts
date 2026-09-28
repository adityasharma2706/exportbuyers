/**
 * M37 — IF-37a: `getPage(locale, slug); listBySection(locale, section); byHsChapter(locale,
 * chapter); string(locale, key, params?)`.
 *
 * [deviation: the LLD gives `getPage(locale, slug)` — two arguments — but content files live at
 * `/content/<locale>/<section>/<slug>.md`, a three-part path. Rather than inventing a fifth
 * argument the LLD does not list, `slug` here is read as the path under the locale directory:
 * either `"<section>"` (shorthand for that section's `index.md`, e.g. `getPage('en','promise')`
 * for the single-page `/promise` route) or `"<section>/<leaf>"` for a section with multiple
 * pages (e.g. `getPage('en','learn/incoterms')`). This keeps the two-argument signature while
 * still addressing every file the directory layout can contain.]
 */
import { AppError } from '../m01_platform/index.js';
import { DEFAULT_LOCALE } from '../m04_ui/index.js';
import { getContentIndex, type ContentIndex } from './loader.js';
import { renderMarkdown, plainTextExcerpt } from './markdown.js';
import { resolvePriceTokens } from './priceTokens.js';
import { isContentSection } from './types.js';
import type { ContentPageDto, ContentPageSummaryDto, ContentSection, ContentSourceDocument, GlossaryTermDto, GrievanceContactDto } from './types.js';

const SECTION_SLUG_RE = /^([a-z0-9-]+)(?:\/([a-z0-9-]+))?$/;

function parseSlug(rawSlug: string): { section: ContentSection; leaf: string } | null {
  const m = SECTION_SLUG_RE.exec(rawSlug.trim());
  if (!m) return null;
  const section = m[1]!;
  if (!isContentSection(section)) return null;
  return { section, leaf: m[2] ?? 'index' };
}

function sectionMap(index: ContentIndex, locale: string, section: ContentSection): Map<string, ContentSourceDocument> | undefined {
  return index.pages.get(locale)?.get(section);
}

function renderedHtml(doc: ContentSourceDocument): string {
  return renderMarkdown(resolvePriceTokens(doc.rawBody));
}

function toSummaryDto(doc: ContentSourceDocument, localeFallback: boolean, html?: string): ContentPageSummaryDto {
  return {
    locale: doc.locale,
    localeFallback,
    section: doc.section,
    slug: doc.slug,
    title: doc.frontMatter.title,
    key: doc.frontMatter.key,
    version: doc.frontMatter.version,
    reviewedBy: doc.frontMatter.reviewedBy ?? null,
    reviewedAt: doc.frontMatter.reviewedAt ?? null,
    hsChapters: doc.frontMatter.hsChapters ?? null,
    excerpt: plainTextExcerpt(html ?? renderedHtml(doc)),
  };
}

function toPageDto(doc: ContentSourceDocument, localeFallback: boolean): ContentPageDto {
  const html = renderedHtml(doc);
  return { ...toSummaryDto(doc, localeFallback, html), html };
}

/** IF-37a `getPage`. Returns null (not an error) for a page that genuinely does not exist, so
 * callers (Next.js pages) can render their own 404. Falls back from the requested locale to `en`
 * (LLD M37 rule: "Missing locale → fall back to en"), never the reverse. */
export function getPage(locale: string, slug: string): ContentPageDto | null {
  const parsed = parseSlug(slug);
  if (!parsed) return null;
  const index = getContentIndex();
  let doc = sectionMap(index, locale, parsed.section)?.get(parsed.leaf);
  let localeFallback = false;
  if (!doc && locale !== DEFAULT_LOCALE) {
    doc = sectionMap(index, DEFAULT_LOCALE, parsed.section)?.get(parsed.leaf);
    localeFallback = doc !== undefined;
  }
  return doc ? toPageDto(doc, localeFallback) : null;
}

/** IF-37a `listBySection`. Empty array for an unknown/empty section rather than throwing, since
 * "no pages yet" is a normal state for a section under construction. */
export function listBySection(locale: string, section: ContentSection): ContentPageSummaryDto[] {
  const index = getContentIndex();
  let bySlug = sectionMap(index, locale, section);
  let localeFallback = false;
  if ((!bySlug || bySlug.size === 0) && locale !== DEFAULT_LOCALE) {
    bySlug = sectionMap(index, DEFAULT_LOCALE, section);
    localeFallback = bySlug !== undefined && bySlug.size > 0;
  }
  if (!bySlug) return [];
  return [...bySlug.values()].map((doc) => toSummaryDto(doc, localeFallback)).sort((a, b) => a.title.localeCompare(b.title));
}

const CHAPTER_RE = /^[0-9]{2}$/;

/** IF-37a `byHsChapter`. Searches every section (in practice `learn`), since REQ-065's Trade
 * Connect / EPC / mission links are authored as Learn pages tagged with `hsChapters`. */
export function byHsChapter(locale: string, chapter: string): ContentPageSummaryDto[] {
  if (!CHAPTER_RE.test(chapter)) {
    throw new AppError('VALIDATION', 'HS chapter must be a 2-digit code', { chapter });
  }
  const index = getContentIndex();
  const collect = (loc: string): ContentSourceDocument[] => {
    const bySection = index.pages.get(loc);
    if (!bySection) return [];
    const out: ContentSourceDocument[] = [];
    for (const bySlug of bySection.values()) {
      for (const doc of bySlug.values()) {
        if (doc.frontMatter.hsChapters?.includes(chapter)) out.push(doc);
      }
    }
    return out;
  };
  let docs = collect(locale);
  let localeFallback = false;
  if (docs.length === 0 && locale !== DEFAULT_LOCALE) {
    docs = collect(DEFAULT_LOCALE);
    localeFallback = docs.length > 0;
  }
  return docs.map((doc) => toSummaryDto(doc, localeFallback)).sort((a, b) => a.title.localeCompare(b.title));
}

function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}

/** IF-37a `string`. Outside production a missing key throws loudly (a content authoring bug); in
 * production it degrades to the raw key, so a missing translation never crashes a page render. */
export function string(
  locale: string,
  key: string,
  params?: Record<string, string | number>,
  env: string | undefined = process.env.NODE_ENV,
): string {
  const index = getContentIndex();
  let value = index.strings.get(locale)?.get(key);
  if (value === undefined && locale !== DEFAULT_LOCALE) {
    value = index.strings.get(DEFAULT_LOCALE)?.get(key);
  }
  if (value === undefined) {
    if (env !== 'production') throw new AppError('NOT_FOUND', `Content string "${key}" not found`, { key, locale });
    return key;
  }
  return params ? fillTemplate(value, params) : value;
}

// ---------------------------------------------------------------------------------------------
// REQ-059 in-context tooltips: structured glossary terms sourced from
// `/content/<locale>/strings/glossary.json` (`glossary.<id>.term` / `glossary.<id>.short`).
// ---------------------------------------------------------------------------------------------

const GLOSSARY_TERM_RE = /^glossary\.([a-z0-9_]+)\.term$/;

/** Canonical order for the tooltip terms REQ-059 names explicitly. Any additional terms authored
 * later are appended after these, alphabetically. */
export const GLOSSARY_TERM_ORDER: readonly string[] = ['hs_itc_hs', 'iec', 'incoterms', 'fob', 'cif', 'moq'];

export function glossaryTerms(locale: string): GlossaryTermDto[] {
  const index = getContentIndex();
  const bag = index.strings.get(locale) ?? index.strings.get(DEFAULT_LOCALE) ?? new Map<string, string>();
  const ids = new Set<string>();
  for (const key of bag.keys()) {
    const m = GLOSSARY_TERM_RE.exec(key);
    if (m) ids.add(m[1]!);
  }
  const rank = (id: string): number => {
    const idx = GLOSSARY_TERM_ORDER.indexOf(id);
    return idx === -1 ? GLOSSARY_TERM_ORDER.length : idx;
  };
  return [...ids]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((id) => ({
      id,
      term: bag.get(`glossary.${id}.term`) ?? id,
      short: bag.get(`glossary.${id}.short`) ?? '',
    }));
}

// ---------------------------------------------------------------------------------------------
// DPDP grievance officer contact (LLD M38 IF-38b: "GET /grievance ... from M37"). M38 does not
// exist yet in this workspace; this exposes the data M38's route will serve so it is a one-line
// import once M38 is built, rather than duplicated legal copy.
// ---------------------------------------------------------------------------------------------

export function grievanceContact(locale: string): GrievanceContactDto | null {
  const index = getContentIndex();
  const bag = index.strings.get(locale) ?? index.strings.get(DEFAULT_LOCALE);
  if (!bag) return null;
  const name = bag.get('legal.grievance.name');
  const email = bag.get('legal.grievance.email');
  const phone = bag.get('legal.grievance.phone');
  const address = bag.get('legal.grievance.address');
  const hoursNote = bag.get('legal.grievance.hoursNote');
  if (!name || !email || !phone || !address || !hoursNote) return null;
  return { name, email, phone, address, hoursNote };
}
