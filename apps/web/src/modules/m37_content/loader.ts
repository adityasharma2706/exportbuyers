/**
 * M37 — builds the static content index from `/content/<locale>/<section>/<slug>.md` and
 * `/content/<locale>/strings/*.json` (LLD M37 decision). File discovery mirrors M28's
 * `catalogue.ts` / M10's `psl.ts` pinned-file pattern: an env override, then a fixed relative path
 * from this file's own location, then a walk up from `cwd`. The index is built once, lazily, and
 * cached in memory ("built into a static index at deploy"); `reloadContentForTesting()` clears the
 * cache so tests can point at a fixture directory.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, log } from '../m01_platform/index.js';
import { type Messages, flattenMessages } from '../m04_ui/index.js';
import { parseContentFile } from './frontmatter.js';
import { isContentSection } from './types.js';
import type { ContentSection, ContentSourceDocument } from './types.js';

export const CONTENT_RELATIVE_PATH = 'content';

function candidateRoots(): string[] {
  const out: string[] = [];
  const env = process.env.M37_CONTENT_DIR;
  if (env && env.trim()) out.push(resolve(env.trim()));
  try {
    // src/modules/m37_content (and dist/modules/m37_content) -> repo root is five levels up.
    const here = dirname(fileURLToPath(import.meta.url));
    out.push(resolve(here, '..', '..', '..', '..', '..', CONTENT_RELATIVE_PATH));
  } catch {
    /* not a file URL (bundled); fall back to walking up from cwd */
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    out.push(join(dir, CONTENT_RELATIVE_PATH));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function findContentRoot(): string | null {
  for (const p of candidateRoots()) {
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }
  return null;
}

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function listFiles(path: string, ext: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isFile() && extname(e.name) === ext)
    .map((e) => e.name);
}

export interface ContentIndex {
  /** locale -> section -> slug -> document */
  pages: Map<string, Map<ContentSection, Map<string, ContentSourceDocument>>>;
  /** locale -> flattened, namespaced microcopy (each `strings/<ns>.json` file under its own top key) */
  strings: Map<string, Map<string, string>>;
  locales: string[];
  root: string | null;
}

function isMessages(value: unknown): value is Messages {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadStringsForLocale(localeDir: string): Map<string, string> {
  const stringsDir = join(localeDir, 'strings');
  const merged: Messages = {};
  for (const file of listFiles(stringsDir, '.json')) {
    const ns = file.slice(0, -'.json'.length);
    const raw = readFileSync(join(stringsDir, file), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new AppError('INTERNAL', `Content strings file ${join(stringsDir, file)} is not valid JSON`, { file }, { cause: e });
    }
    if (!isMessages(parsed)) {
      throw new AppError('INTERNAL', `Content strings file ${join(stringsDir, file)} must be a JSON object`, { file });
    }
    merged[ns] = parsed;
  }
  return flattenMessages(merged);
}

function loadPagesForLocale(localeDir: string, locale: string): Map<ContentSection, Map<string, ContentSourceDocument>> {
  const bySection = new Map<ContentSection, Map<string, ContentSourceDocument>>();
  for (const dirName of listDirs(localeDir)) {
    if (dirName === 'strings') continue;
    if (!isContentSection(dirName)) {
      log.warn({ locale, section: dirName }, 'm37: skipping unknown content section directory');
      continue;
    }
    const section = dirName;
    const sectionDir = join(localeDir, section);
    const slugs = new Map<string, ContentSourceDocument>();
    for (const file of listFiles(sectionDir, '.md')) {
      const slug = file.slice(0, -'.md'.length);
      const sourcePath = join(sectionDir, file);
      const raw = readFileSync(sourcePath, 'utf8');
      const { frontMatter, rawBody } = parseContentFile(raw, sourcePath);
      slugs.set(slug, { locale, section, slug, frontMatter, rawBody, sourcePath });
    }
    bySection.set(section, slugs);
  }
  return bySection;
}

function build(): ContentIndex {
  const root = findContentRoot();
  const pages = new Map<string, Map<ContentSection, Map<string, ContentSourceDocument>>>();
  const strings = new Map<string, Map<string, string>>();
  const locales: string[] = [];
  if (root) {
    for (const locale of listDirs(root)) {
      locales.push(locale);
      const localeDir = join(root, locale);
      pages.set(locale, loadPagesForLocale(localeDir, locale));
      strings.set(locale, loadStringsForLocale(localeDir));
    }
  } else {
    log.warn({ candidates: candidateRoots() }, 'm37: content directory not found; content API will return empty results');
  }
  return { pages, strings, locales, root };
}

let cached: ContentIndex | undefined;

export function getContentIndex(): ContentIndex {
  if (!cached) cached = build();
  return cached;
}

/** Test hook: forces the next getContentIndex() to rebuild from disk (or from an env override). */
export function reloadContentForTesting(): void {
  cached = undefined;
}

/** All documents across every locale and section, for the build-time lint checks. */
export function allDocuments(index: ContentIndex = getContentIndex()): ContentSourceDocument[] {
  const out: ContentSourceDocument[] = [];
  for (const bySection of index.pages.values()) {
    for (const bySlug of bySection.values()) {
      for (const doc of bySlug.values()) out.push(doc);
    }
  }
  return out;
}
