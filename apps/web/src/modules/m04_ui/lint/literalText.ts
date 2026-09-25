/**
 * M04 — "no literal UI text" check (REQ-058).
 *
 * The LLD enforces "every string comes from t(key)" with ESLint's i18next/no-literal-string rule on
 * JSX text. The workspace typecheck currently has no JSX setting, so M04's components are written
 * with `createElement` (imported as `h`), which that rule's JSX mode cannot see. This scanner
 * covers the gap: it flags any string or template literal passed as a *child* argument (3rd and
 * later) of an `h(...)` call. Props (2nd argument) are not text and are ignored.
 */

export interface LiteralTextViolation {
  line: number;
  column: number;
  text: string;
}

const TEXTUAL = /[\p{L}\p{N}]/u;

/** Scans TypeScript source for literal children of `h(...)` calls. */
export function findLiteralChildren(source: string, calleeName = 'h'): LiteralTextViolation[] {
  const violations: LiteralTextViolation[] = [];
  const callee = new RegExp(`(^|[^A-Za-z0-9_$.])${escapeRegExp(calleeName)}\\s*\\(`, 'g');
  const code = maskComments(source);
  let match: RegExpExecArray | null;
  while ((match = callee.exec(code)) !== null) {
    const open = match.index + match[0].length - 1;
    const args = splitArguments(code, open);
    for (let i = 2; i < args.length; i++) {
      const arg = args[i];
      if (!arg) continue;
      const trimmed = arg.text.trim();
      const literal = literalValue(trimmed);
      if (literal !== null && TEXTUAL.test(literal)) {
        const offset = arg.start + arg.text.indexOf(trimmed);
        const { line, column } = position(source, offset);
        violations.push({ line, column, text: literal });
      }
    }
  }
  return violations;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces comments with spaces (keeping offsets) so commented-out code is not scanned. */
function maskComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Returns the index just past the string/template literal starting at `start`. */
function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && src[i + 1] === '{') {
      i = skipBalanced(src, i + 1);
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote !== '`' && ch === '\n') return i;
    i++;
  }
  return i;
}

/** Skips a balanced (...), [...] or {...} group starting at `open`; returns the index past it. */
function skipBalanced(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  let i = open;
  while (i < src.length) {
    const ch = src[i] ?? '';
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(src, i);
      continue;
    }
    const close = pairs[ch];
    if (close) {
      stack.push(close);
    } else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
    i++;
  }
  return i;
}

interface ArgSpan {
  start: number;
  text: string;
}

/** Splits the top-level arguments of the call whose "(" is at `open`. */
function splitArguments(src: string, open: number): ArgSpan[] {
  const end = skipBalanced(src, open) - 1;
  const args: ArgSpan[] = [];
  let depth = 0;
  let argStart = open + 1;
  let i = open + 1;
  while (i < end) {
    const ch = src[i] ?? '';
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(src, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      args.push({ start: argStart, text: src.slice(argStart, i) });
      argStart = i + 1;
    }
    i++;
  }
  const last = src.slice(argStart, end);
  if (last.trim().length > 0) args.push({ start: argStart, text: last });
  return args;
}

/** If `expr` is exactly one string literal (or a template without substitutions), its value. */
function literalValue(expr: string): string | null {
  if (expr.length < 2) return null;
  const quote = expr[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  if (skipString(expr, 0) !== expr.length) return null;
  const body = expr.slice(1, -1);
  if (quote === '`') {
    // Template text outside ${...} still counts as literal UI text.
    return body.replace(/\$\{[^}]*\}/g, '');
  }
  return body;
}

function position(src: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}
