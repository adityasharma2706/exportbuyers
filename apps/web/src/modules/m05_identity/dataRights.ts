/**
 * M05 — data rights hooks (IF-38a). M38 calls these when handling DPDP requests.
 *  - export: the members' identifiers.
 *  - erase:  after the account is closed, delete sessions and null phone and email.
 */
import { AppError, isUuid } from '../m01_platform/index.js';
import { accountStatus, eraseAccountIdentity, membersOfAccount } from './repo.js';

export interface IdentityExport {
  module: 'M05';
  members: Array<{
    memberId: string;
    phoneE164: string | null;
    email: string | null;
    role: string;
    isAdmin: boolean;
    createdAt: string;
  }>;
}

export async function exportIdentity(accountId: string): Promise<IdentityExport> {
  if (!isUuid(accountId)) throw new AppError('VALIDATION', 'accountId must be a uuid');
  const members = await membersOfAccount(accountId);
  return {
    module: 'M05',
    members: members.map((m) => ({
      memberId: m.id,
      phoneE164: m.phone_e164,
      email: m.email,
      role: m.role,
      isAdmin: m.is_admin,
      createdAt: m.created_at.toISOString(),
    })),
  };
}

/** Refuses with CONFLICT while the account is still active. Returns the number of members erased. */
export async function eraseIdentity(accountId: string): Promise<{ membersErased: number }> {
  if (!isUuid(accountId)) throw new AppError('VALIDATION', 'accountId must be a uuid');
  const status = await accountStatus(accountId);
  if (status === undefined) throw new AppError('NOT_FOUND', 'Account not found');
  if (status === 'active') throw new AppError('CONFLICT', 'Close the account before erasing identifiers', { status });
  const membersErased = await eraseAccountIdentity(accountId, new Date());
  return { membersErased };
}
