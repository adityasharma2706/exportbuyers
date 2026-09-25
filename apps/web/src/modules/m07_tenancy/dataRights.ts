/**
 * M07 — data rights hooks (IF-38a). M38 calls these for DPDP requests.
 *  - export: the business profile and every workspace (including soft-deleted ones).
 *  - erase:  hard-deletes profile, workspaces and idempotency records. The account must
 *            already be closed (status ≠ 'active'); M38 runs this before M06 (last).
 */
import { AppError, isUuid } from '../m01_platform/index.js';
import { accountStatusOf, eraseAccountTenancy, profileForAccount, workspacesForAccount } from './repo.js';

export interface TenancyExport {
  module: 'M07';
  profile: Record<string, unknown> | null;
  workspaces: Array<Record<string, unknown>>;
}

export async function exportTenancy(accountId: string): Promise<TenancyExport> {
  if (!isUuid(accountId)) throw new AppError('VALIDATION', 'accountId must be a uuid');
  const [p, ws] = await Promise.all([profileForAccount(accountId), workspacesForAccount(accountId)]);
  return {
    module: 'M07',
    profile: p
      ? {
          businessName: p.businessName,
          city: p.city,
          state: p.state,
          whatTheyMake: p.whatTheyMake,
          exportExperience: p.exportExperience,
          iec: p.iec,
          iecVerifiedAt: p.iecVerifiedAt?.toISOString() ?? null,
          targetMarkets: p.targetMarkets,
          senderName: p.senderName,
          senderEmail: p.senderEmail,
          website: p.website,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        }
      : null,
    workspaces: ws.map((w) => ({
      id: w.id,
      name: w.name,
      hs: w.hs,
      countries: w.countries,
      deletedAt: w.deletedAt?.toISOString() ?? null,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    })),
  };
}

export async function eraseTenancy(accountId: string): Promise<{ profiles: number; workspaces: number }> {
  if (!isUuid(accountId)) throw new AppError('VALIDATION', 'accountId must be a uuid');
  const status = await accountStatusOf(accountId);
  if (status === undefined) throw new AppError('NOT_FOUND', 'Account not found');
  if (status === 'active') throw new AppError('CONFLICT', 'Close the account before erasing tenancy data', { status });
  return eraseAccountTenancy(accountId);
}
