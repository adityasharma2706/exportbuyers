/**
 * M37 — YAML front matter parsing for `/content/<locale>/<section>/<slug>.md` files (LLD M37
 * decision). `js-yaml` is already a runtime dependency of this workspace (M28's price catalogue
 * loader); M28's `js-yaml.d.ts` ambient declaration (apps/web/src/modules/m28_credits/js-yaml.d.ts)
 * is what makes `import { load } from 'js-yaml'` type-check under this workspace's `bundler`
 * module resolution, so nothing is redeclared here.
 */
import { load as loadYaml } from 'js-yaml';
import { AppError } from '../m01_platform/index.js';
import type { ContentFrontMatter } from './types.js';

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const CHAPTER_RE = /^[0-9]{2}$/;

export interface ParsedMarkdownFile {
  data: Record<string, unknown>;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Splits a Markdown file into its front matter object and the remaining body. A file with no
 * `---` fenced block at the top is treated as having empty front matter (the caller then fails
 * validation, since `title`/`key`/`version` are required). */
export function splitFrontMatter(raw: string, sourcePath: string): ParsedMarkdownFile {
  const match = FRONT_MATTER_RE.exec(raw);
  if (!match) return { data: {}, body: raw };
  const block = match[1] ?? '';
  const body = raw.slice(match[0].length);
  let parsed: unknown;
  try {
    parsed = block.trim() === '' ? {} : loadYaml(block);
  } catch (e) {
    throw new AppError('INTERNAL', `Content front matter at ${sourcePath} is not valid YAML`, { sourcePath }, { cause: e });
  }
  if (parsed === null || parsed === undefined) return { data: {}, body };
  if (!isRecord(parsed)) {
    throw new AppError('INTERNAL', `Content front matter at ${sourcePath} must be a YAML mapping`, { sourcePath });
  }
  return { data: parsed, body };
}

function requiredString(data: Record<string, unknown>, field: string, sourcePath: string): string {
  const v = data[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new AppError('INTERNAL', `Content front matter at ${sourcePath} is missing required field "${field}"`, { sourcePath, field });
  }
  return v;
}

function optionalString(data: Record<string, unknown>, field: string, sourcePath: string): string | undefined {
  const v = data[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.trim() === '') {
    throw new AppError('INTERNAL', `Content front matter at ${sourcePath} field "${field}" must be a non-empty string`, { sourcePath, field });
  }
  return v;
}

function optionalHsChapters(data: Record<string, unknown>, sourcePath: string): string[] | undefined {
  const v = data.hsChapters;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length === 0) {
    throw new AppError('INTERNAL', `Content front matter at ${sourcePath} field "hsChapters" must be a non-empty array of 2-digit codes`, {
      sourcePath,
    });
  }
  const out: string[] = [];
  for (const raw of v) {
    const code = typeof raw === 'number' ? String(raw).padStart(2, '0') : raw;
    if (typeof code !== 'string' || !CHAPTER_RE.test(code)) {
      throw new AppError('INTERNAL', `Content front matter at ${sourcePath} has an invalid HS chapter "${String(raw)}" (must be 2 digits)`, {
        sourcePath,
        value: raw,
      });
    }
    out.push(code);
  }
  return [...new Set(out)];
}

/** Validates a parsed front-matter object against the LLD shape. Throws INTERNAL (a content
 * authoring bug) rather than degrading, since bad content is a deploy-time defect, not a runtime
 * input the visitor controls. */
export function validateFrontMatter(data: Record<string, unknown>, sourcePath: string): ContentFrontMatter {
  const fm: ContentFrontMatter = {
    title: requiredString(data, 'title', sourcePath),
    key: requiredString(data, 'key', sourcePath),
    version: requiredString(data, 'version', sourcePath),
  };
  const hsChapters = optionalHsChapters(data, sourcePath);
  if (hsChapters) fm.hsChapters = hsChapters;
  const reviewedBy = optionalString(data, 'reviewedBy', sourcePath);
  if (reviewedBy) fm.reviewedBy = reviewedBy;
  const reviewedAt = optionalString(data, 'reviewedAt', sourcePath);
  if (reviewedAt) {
    if (Number.isNaN(Date.parse(reviewedAt))) {
      throw new AppError('INTERNAL', `Content front matter at ${sourcePath} field "reviewedAt" is not a valid date`, { sourcePath });
    }
    fm.reviewedAt = reviewedAt;
  }
  return fm;
}

export function parseContentFile(raw: string, sourcePath: string): { frontMatter: ContentFrontMatter; rawBody: string } {
  const { data, body } = splitFrontMatter(raw, sourcePath);
  return { frontMatter: validateFrontMatter(data, sourcePath), rawBody: body };
}
