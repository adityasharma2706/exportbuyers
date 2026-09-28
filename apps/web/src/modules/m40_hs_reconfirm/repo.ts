/**
 * M40 — cross-tenant access to serving.workspace (M07's table) for the nomenclature re-check
 * scan. A version reload can affect workspaces across every account, so this reads and writes
 * through systemDb() rather than M07's per-account API; the reason is logged on every call, the
 * same way M07's own purge job (m07_tenancy/repo.ts `sys()`) touches this table unscoped.
 */
import { sql } from 'kysely';
import { systemDb, type Db } from '../m01_platform/index.js';
import type { HsFamily } from '../m12_hs/index.js';
import type { WorkspaceHsScanRow } from './types.js';

function sys(reason: string): Db {
  return systemDb(`m40: ${reason}`);
}

/**
 * One page of live workspaces whose `hs_version` is in `family` and differs from `newVersion`,
 * ordered by id for keyset pagination (`afterId`, exclusive; null for the first page).
 */
export async function nextBatch(
  family: HsFamily,
  newVersion: string,
  afterId: string | null,
  limit: number,
): Promise<WorkspaceHsScanRow[]> {
  const cursor = afterId ? sql`and id > ${afterId}::uuid` : sql``;
  const res = await sql<WorkspaceHsScanRow>`
    select id, account_id, name, hs_code, hs_level, hs_version
      from serving.workspace
     where deleted_at is null
       and hs_version is not null
       and hs_version <> ${newVersion}
       and regexp_replace(hs_version, '[0-9]{4}$', '') = ${family}
       ${cursor}
     order by id
     limit ${limit}`.execute(sys('scan workspaces after a nomenclature version change'));
  return res.rows;
}

/** 1:1-same-code match: the workspace moves to the new version with no user action, flag stays clear. */
export async function updateVersionSilently(id: string, newVersion: string): Promise<void> {
  await sql`
    update serving.workspace
       set hs_version = ${newVersion}, hs_needs_reconfirm = false, updated_at = now()
     where id = ${id}::uuid and deleted_at is null`.execute(sys('carry an HS code over to the new nomenclature version'));
}

/** Anything else: the code and version stay as they are (saved searches keep working, LLD M40) and the workspace is flagged. */
export async function flagForReconfirm(id: string): Promise<void> {
  await sql`
    update serving.workspace
       set hs_needs_reconfirm = true, updated_at = now()
     where id = ${id}::uuid and deleted_at is null`.execute(sys('flag a workspace for HS re-confirmation'));
}
