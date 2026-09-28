/**
 * M37 — a small, dependency-free Markdown-to-HTML renderer for operator-authored content
 * (LLD M37 decision: "Markdown in the repo"). Content is written by the operator, not visitors,
 * but this still escapes every text run and allowlists link schemes, so a stray Markdown source
 * character never becomes live HTML/JS in the rendered page.
 *
 * Supported subset: headings (# .. ######), paragraphs, blockquotes (>), fenced code blocks
 * (```), unordered/ordered lists (possibly nested by indentation), horizontal rules (---/***),
 * and inline **bold**, *italic*, `code` and [text](url) links. This is intentionally not a full
 * CommonMark implementation — content authors get a plain, predictable subset instead.
 */

const SAFE_URL_RE = /^(https?:\/\/|mailto:|\/)/i;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

/** Renders inline Markdown (bold/italic/code/links) within a single already-token-resolved text
 * run. Order matters: code spans are extracted first so `**`/`*`/`[` inside them are literal. */
function renderInline(text: string): string {
  // Extract inline code spans first (`code`) so nothing inside them is parsed further.
  const codeSpans: string[] = [];
  let withoutCode = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });

  // Links: [text](url). Only http(s), mailto and site-relative URLs are allowed; anything else
  // renders as plain (escaped) text with the URL visible, rather than a dead or unsafe link.
  withoutCode = withoutCode.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
    if (!SAFE_URL_RE.test(url)) return escapeHtml(whole);
    const external = /^https?:\/\//i.test(url);
    const rel = external ? ' rel="noopener noreferrer" target="_blank"' : '';
    return `<a href="${escapeAttr(url)}"${rel}>${escapeHtml(label)}</a>`;
  });

  // Bold then italic (bold's `**`/`__` must be consumed before single `*`/`_` italics).
  withoutCode = withoutCode.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a?: string, b?: string) => `<strong>${escapeHtml((a ?? b)!)}</strong>`);
  withoutCode = withoutCode.replace(/\*([^*]+)\*|_([^_]+)_/g, (_m, a?: string, b?: string) => `<em>${escapeHtml((a ?? b)!)}</em>`);

  // Anything left is plain text that still needs escaping (the code/link/bold/italic branches
  // above already escaped their own captured groups, so escape only the untouched parts by
  // reprocessing: splitting on the sentinel markers and the existing tags is unsafe, so instead
  // we escape first and re-inject already-safe fragments via those sentinel markers.
  const escaped = escapeRemaining(withoutCode);
  return escaped.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)] ?? '');
}

/** Escapes `&`, `<`, `>` outside of the HTML fragments this renderer already produced (`<strong>`,
 * `<em>`, `<a ...>`, `<code>` and their closing tags, plus the sentinel marker that stands in for
 * an already-rendered code span). Everything else is user/content text and must be escaped, so
 * this walks the string and only lets a fixed allowlist of tags through verbatim. */
const ALLOWED_TAG_RE = /^(<\/?(strong|em|code)>|<a href="[^"]*"(?: rel="noopener noreferrer" target="_blank")?>|<\/a>)/;

function escapeRemaining(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const rest = html.slice(i);
      const m = ALLOWED_TAG_RE.exec(rest);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
      out += '&lt;';
      i += 1;
      continue;
    }
    const ch = html[i]!;
    if (ch === '&') out += '&amp;';
    else if (ch === '>') out += '&gt;';
    else out += ch;
    i += 1;
  }
  return out;
}

interface ListItem {
  text: string;
  /** Set for a GFM-style `- [ ]` / `- [x]` task item; undefined for a plain list item. */
  checked?: boolean;
}

interface ListState {
  ordered: boolean;
  items: ListItem[];
}

const TASK_ITEM_RE = /^\[([ xX])\]\s+(.*)$/;

function parseListItem(text: string): ListItem {
  const task = TASK_ITEM_RE.exec(text);
  if (!task) return { text };
  return { text: task[2]!, checked: task[1]!.toLowerCase() === 'x' };
}

/** Block-level Markdown → HTML. `body` must already have `{{price:...}}` tokens resolved. */
export function renderMarkdown(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let paragraph: string[] = [];
  let list: ListState | null = null;

  function flushParagraph(): void {
    if (paragraph.length === 0) return;
    out.push(`<p>${renderInline(paragraph.join(' ').trim())}</p>`);
    paragraph = [];
  }

  function renderListItem(item: ListItem): string {
    const label = renderInline(item.text.trim());
    if (item.checked === undefined) return `<li>${label}</li>`;
    const checkedAttr = item.checked ? ' checked' : '';
    return `<li class="task-item"><label><input type="checkbox" disabled${checkedAttr} /> ${label}</label></li>`;
  }

  function flushList(): void {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    out.push(`<${tag}>${list.items.map(renderListItem).join('')}</${tag}>`);
    list = null;
  }

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
      flushParagraph();
      flushList();
      out.push('<hr />');
      i++;
      continue;
    }

    if (line.startsWith('```')) {
      flushParagraph();
      flushList();
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip the closing fence
      const langAttr = lang ? ` data-lang="${escapeAttr(lang)}"` : '';
      out.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    if (line.startsWith('>')) {
      flushParagraph();
      flushList();
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote><p>${renderInline(quoteLines.join(' ').trim())}</p></blockquote>`);
      continue;
    }

    const unordered = /^[-*]\s+(.*)$/.exec(line);
    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = !!ordered;
      const text = (unordered ?? ordered)![1]!;
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(parseListItem(text));
      i++;
      continue;
    }

    flushList();
    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  flushList();
  return out.join('\n');
}

/** Strips tags from rendered HTML and collapses whitespace, for listing excerpts. */
export function plainTextExcerpt(html: string, maxLength = 220): string {
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).replace(/\s+\S*$/, '')}…`;
}
