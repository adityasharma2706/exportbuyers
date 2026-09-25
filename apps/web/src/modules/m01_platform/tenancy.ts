/**
 * M01 — TenantTable registry (LLD M01 Rules).
 *
 * Maps each serving table to its tenancy scope:
 *   'account'   — rows carry account_id; every query is filtered by ctx.accountId.
 *   'workspace' — rows carry account_id AND workspace_id; filtered by both.
 *   'global'    — no tenant columns (reference data); no filter is added.
 *
 * Owning modules register their tables at import time from their own repo.ts, e.g.
 *   registerTenantTable('serving.workspace', 'account');
 * and add the row type through declaration merging:
 *   declare module '../m01_platform/tenancy.js' { interface TenantTableRows { 'serving.workspace': WorkspaceRow } }
 * (TypeScript only merges augmentations into the declaring file, so this type-only
 * augmentation is the one sanctioned exception to the "import through index.ts" rule.)
 *
 * Lookups for tables that were never registered fail closed with INTERNAL, so a module
 * cannot accidentally run an unfiltered query by forgetting to register.
 */
import { AppError } from './errors.js';

export type TenantScope = 'account' | 'workspace' | 'global';

/**
 * Row types per table, extended by owning modules through declaration merging.
 * Keys are fully-qualified table names ("schema.table").
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TenantTableRows {}

/** Known table names autocomplete; any other "schema.table" string is checked at runtime. */
export type TenantTable = Extract<keyof TenantTableRows, string> | (string & {});

export type Row<T extends string> = T extends keyof TenantTableRows ? TenantTableRows[T] : Record<string, unknown>;

const registry = new Map<string, TenantScope>();

const TABLE_NAME_RE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/** Schemas whose tables are tenant data and may be registered here. */
const SCOPABLE_SCHEMAS = new Set(['serving', 'ledger', 'platform']);

export function registerTenantTable(table: string, scope: TenantScope): void {
  if (!TABLE_NAME_RE.test(table)) {
    throw new AppError('INTERNAL', `Tenant table name must be "schema.table" in lower snake case; got "${table}"`);
  }
  const schema = table.slice(0, table.indexOf('.'));
  if (!SCOPABLE_SCHEMAS.has(schema)) {
    throw new AppError('INTERNAL', `Table ${table} is not in a serving-plane schema and cannot be tenant-registered`);
  }
  const existing = registry.get(table);
  if (existing !== undefined && existing !== scope) {
    throw new AppError('INTERNAL', `Table ${table} already registered as '${existing}', cannot re-register as '${scope}'`);
  }
  registry.set(table, scope);
}

/** Splits "serving.search as s" into table and alias. */
export function parseTableRef(ref: string): { table: string; alias: string } {
  const m = /^\s*([a-z0-9_.]+)(?:\s+as\s+([a-z_][a-z0-9_]*))?\s*$/i.exec(ref);
  if (!m) throw new AppError('INTERNAL', `Invalid table reference "${ref}"`);
  const table = m[1]!.toLowerCase();
  return { table, alias: m[2] ?? table };
}

export function tenantScopeOf(table: string): TenantScope {
  const { table: t } = parseTableRef(table);
  const scope = registry.get(t);
  if (scope === undefined) {
    throw new AppError('INTERNAL', `Table ${t} is not in the TenantTable registry; register it before querying through scoped()`);
  }
  return scope;
}

export function registeredTenantTables(): ReadonlyMap<string, TenantScope> {
  return new Map(registry);
}

/** For tests only. */
export function clearTenantRegistryForTesting(): void {
  registry.clear();
}
