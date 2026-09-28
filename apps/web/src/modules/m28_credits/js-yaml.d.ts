/**
 * M28 — local ambient declaration for `js-yaml`.
 *
 * js-yaml 4.x ships an `exports` map with no `types` condition and no top-level `types`/`typings`
 * field, so under this workspace's `moduleResolution: "bundler"` (tsconfig.json) TypeScript
 * resolves the import straight to `dist/js-yaml.mjs` for type-checking purposes and never
 * consults a separately-installed `@types/js-yaml` package, producing an implicit-`any` (TS7016)
 * on the named import in catalogue.ts. Declaring the module locally (an ambient declaration
 * always wins over on-disk resolution for a given specifier) fixes the type error without
 * widening anything to `any`; only the single export this module actually uses is declared, with
 * an accurate signature that mirrors the real runtime API and keeps the parsed result as
 * `unknown` (catalogue.ts already narrows it via parseCatalogueDocument's own validation).
 */
declare module 'js-yaml' {
  /** Parses a single YAML document; throws `YAMLException` on invalid input. */
  export function load(input: string, options?: Record<string, unknown>): unknown;
}
