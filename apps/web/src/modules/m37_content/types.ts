/**
 * M37 Content, Learn and promise pages — shared types (LLD M37, IF-37a).
 *
 * Content lives as Markdown files at `/content/<locale>/<section>/<slug>.md` with YAML front
 * matter `{title, key, hsChapters?, version, reviewedBy?, reviewedAt?}`, plus microcopy JSON at
 * `/content/<locale>/strings/*.json`. The loader (loader.ts) builds an in-memory index from these
 * files (LLD: "built into a static index at deploy"); this file only defines the shapes.
 */

/** Top-level content areas (LLD M37 "Pages"). Each is a directory under `/content/<locale>/`. */
export const CONTENT_SECTIONS = [
  'learn',
  'glossary',
  'scam-red-flags',
  'first-export-checklist',
  'promise',
  'coverage',
  'refund-policy',
  'pricing',
] as const;
export type ContentSection = (typeof CONTENT_SECTIONS)[number];

export function isContentSection(value: unknown): value is ContentSection {
  return typeof value === 'string' && (CONTENT_SECTIONS as readonly string[]).includes(value);
}

/** Pages whose prose must never contain a hardcoded ₹ amount or "N credit(s)" literal (LLD rule). */
export const PRICE_SENSITIVE_SECTIONS: readonly ContentSection[] = ['promise', 'refund-policy', 'pricing'];

/** Front matter fields (LLD M37 decision), as they appear in the YAML block. */
export interface ContentFrontMatter {
  title: string;
  key: string;
  hsChapters?: string[];
  version: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

/** A parsed Markdown file before rendering: front matter + the raw Markdown body. */
export interface ContentSourceDocument {
  locale: string;
  section: ContentSection;
  slug: string;
  frontMatter: ContentFrontMatter;
  /** Markdown body, front matter stripped, `{{price:...}}` tokens not yet resolved. */
  rawBody: string;
  /** Absolute path this document was read from (diagnostics only). */
  sourcePath: string;
}

/** Summary shape returned by listBySection / byHsChapter (no rendered HTML). */
export interface ContentPageSummaryDto {
  locale: string;
  /** True when the requested locale had no file for this page and `en` was served instead. */
  localeFallback: boolean;
  section: ContentSection;
  slug: string;
  title: string;
  key: string;
  version: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  hsChapters: string[] | null;
  /** First ~200 characters of rendered body text, for listings and search previews. */
  excerpt: string;
}

/** Full page shape returned by getPage: the summary plus sanitised, render-ready HTML. */
export interface ContentPageDto extends ContentPageSummaryDto {
  /** Sanitised HTML with `{{price:...}}` tokens already resolved through IF-28c. */
  html: string;
}

/** IF-37a. Other modules (and this module's own routes/pages) call only these four. `slug` is the
 * path under the locale directory — `"<section>"` (shorthand for that section's `index.md`) or
 * `"<section>/<leaf>"` — see the [deviation] note on getPage() in service.ts. */
export interface ContentApi {
  getPage(locale: string, slug: string): ContentPageDto | null;
  listBySection(locale: string, section: ContentSection): ContentPageSummaryDto[];
  byHsChapter(locale: string, chapter: string): ContentPageSummaryDto[];
  string(locale: string, key: string, params?: Record<string, string | number>): string;
}

/** Structured glossary entry, sourced from `/content/<locale>/strings/glossary.json`, for
 * in-context tooltips (REQ-059). `id` matches the anchor used on the `/glossary` page. */
export interface GlossaryTermDto {
  id: string;
  term: string;
  short: string;
}

/** The grievance officer's contact (DPDP), sourced from `/content/<locale>/strings/legal.json`.
 * M38's `GET /grievance` route serves this once M38 exists (LLD M38 IF-38b: "from M37"). */
export interface GrievanceContactDto {
  name: string;
  email: string;
  phone: string;
  address: string;
  hoursNote: string;
}
