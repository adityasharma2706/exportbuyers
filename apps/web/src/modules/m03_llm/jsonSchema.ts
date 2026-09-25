/**
 * M03 — structured-output helpers: extract JSON from model text and validate it against
 * the request's JSON Schema.
 *
 * The validator covers the subset of JSON Schema used for LLM structured output:
 * type (incl. type arrays), enum, const, properties, required, additionalProperties,
 * items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum,
 * exclusiveMinimum, exclusiveMaximum, anyOf, oneOf, allOf, nullable.
 * Unsupported keywords are ignored (permissive), matching common validator behaviour.
 */

type Schema = Record<string, unknown>;

export type ParseOutcome = { ok: true; value: unknown } | { ok: false; error: string };

const MAX_ERRORS = 10;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

function validateAt(value: unknown, schema: unknown, path: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS) return;
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push(`${path}: no value is allowed here`);
    return;
  }
  if (!isObj(schema)) return;
  const s = schema as Schema;

  if (s.nullable === true && value === null) return;

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as unknown[]).map(String) : [String(s.type)];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
  }
  if ('const' in s && !deepEqual(s.const, value)) {
    errors.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) errors.push(`${path}: longer than ${s.maxLength}`);
    if (typeof s.pattern === 'string') {
      let re: RegExp | undefined;
      try {
        re = new RegExp(s.pattern, 'u');
      } catch {
        re = undefined;
      }
      if (re && !re.test(value)) errors.push(`${path}: does not match pattern ${s.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) errors.push(`${path}: less than ${s.minimum}`);
    if (typeof s.maximum === 'number' && value > s.maximum) errors.push(`${path}: greater than ${s.maximum}`);
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) {
      errors.push(`${path}: must be greater than ${s.exclusiveMinimum}`);
    }
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) {
      errors.push(`${path}: must be less than ${s.exclusiveMaximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
    if (s.items !== undefined && !Array.isArray(s.items)) {
      value.forEach((item, i) => validateAt(item, s.items, `${path}[${i}]`, errors));
    }
  }

  if (isObj(value)) {
    const props = isObj(s.properties) ? (s.properties as Record<string, unknown>) : {};
    if (Array.isArray(s.required)) {
      for (const r of s.required) {
        if (typeof r === 'string' && !Object.prototype.hasOwnProperty.call(value, r)) {
          errors.push(`${path}: missing required property "${r}"`);
        }
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        validateAt(v, props[k], `${path}.${k}`, errors);
      } else if (s.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${k}"`);
      } else if (isObj(s.additionalProperties)) {
        validateAt(v, s.additionalProperties, `${path}.${k}`, errors);
      }
    }
  }

  if (Array.isArray(s.allOf)) for (const sub of s.allOf) validateAt(value, sub, path, errors);
  if (Array.isArray(s.anyOf)) {
    const ok = s.anyOf.some((sub) => {
      const e: string[] = [];
      validateAt(value, sub, path, e);
      return e.length === 0;
    });
    if (!ok) errors.push(`${path}: does not match any allowed schema (anyOf)`);
  }
  if (Array.isArray(s.oneOf)) {
    const n = s.oneOf.filter((sub) => {
      const e: string[] = [];
      validateAt(value, sub, path, e);
      return e.length === 0;
    }).length;
    if (n !== 1) errors.push(`${path}: must match exactly one schema (oneOf), matched ${n}`);
  }
}

/** Returns validation errors (empty when valid). Paths are rooted at "$". */
export function validateJson(value: unknown, schema: object): string[] {
  const errors: string[] = [];
  validateAt(value, schema, '$', errors);
  return errors.slice(0, MAX_ERRORS);
}

/**
 * Extracts a JSON value from model text: accepts bare JSON, a ```json fenced block, or
 * the outermost {...} / [...] span surrounded by prose.
 */
export function extractJson(text: string): ParseOutcome {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const firstObj = trimmed.indexOf('{');
  const lastObj = trimmed.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) candidates.push(trimmed.slice(firstObj, lastObj + 1));
  const firstArr = trimmed.indexOf('[');
  const lastArr = trimmed.lastIndexOf(']');
  if (firstArr >= 0 && lastArr > firstArr) candidates.push(trimmed.slice(firstArr, lastArr + 1));

  let lastErr = 'empty response';
  for (const c of candidates) {
    if (c.length === 0) continue;
    try {
      return { ok: true, value: JSON.parse(c) as unknown };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: `response is not valid JSON (${lastErr})` };
}

/** Parse + validate. The error string is suitable for appending to a repair prompt. */
export function parseAndValidate(text: string, schema: object): ParseOutcome {
  const parsed = extractJson(text);
  if (!parsed.ok) return parsed;
  const errors = validateJson(parsed.value, schema);
  if (errors.length > 0) return { ok: false, error: `response does not match the JSON schema: ${errors.join('; ')}` };
  return parsed;
}
