// Shared platform types (LLD §0.2, §0.4 / DS-01).

/** Branded id type: `Id<'account'>` is a string that cannot be mixed with other id kinds. */
export type Id<T extends string> = string & { __brand: T };

export type ActorKind = 'anonymous' | 'user' | 'admin' | 'system';

export type Role =
  | 'owner'
  | 'member'
  | 'consultant'
  | 'admin_support'
  | 'admin_ops'
  | 'admin_super';

/** Public name for the actor's role within an account (or admin role); same union as `Role`. */
export type ActorRole = Role;

/** Deployment environment. Every non-local environment runs in a single India region. */
export type AppEnv = 'local' | 'test' | 'staging' | 'production';

export interface Entitlements {
  plan: 'anonymous' | 'free' | 'starter' | 'growth';
  searchResultCap: number;
  exportRowsPerMonth: number;
  bulkRevealMax: number;
  checksPerMonth: number;
  revealsIncludedPerMonth: number;
}

export interface ActorContext {
  kind: ActorKind;
  accountId?: Id<'account'>;
  memberId?: Id<'member'>;
  workspaceId?: Id<'workspace'>;
  /** Present when kind = 'anonymous'. */
  anonSessionId?: string;
  role?: Role;
  entitlements: Entitlements;
  locale: 'en' | 'hi';
  /** The user's country code (ISO-3166 alpha-2), from profile or IP geolocation. */
  region: string;
  mfaVerified: boolean;
  correlationId: string;
}

/**
 * Registry of serving tables that `scoped()` may touch, with their row shapes.
 * Later modules add their tables by module augmentation:
 *
 * ```ts
 * declare module '../m01_platform/index.js' {
 *   interface ServingTables { 'serving.saved_list': SavedListRow }
 * }
 * ```
 * and register the runtime scope with `registerTenantTables(...)`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ServingTables {}

export type TenantTable = keyof ServingTables & string;
export type Row<T extends TenantTable> = ServingTables[T];
export type TenantScope = 'account' | 'workspace' | 'global';
