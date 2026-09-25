/**
 * M06 — data rights hooks (IF-38a). M38 calls these when handling DPDP requests.
 *  - export: the full consent and withdrawal history, with the notice versions.
 *  - erase:  runs last (M38 order). The history is KEPT as proof of consent; only the IP
 *            address is nulled. The account must already be closed.
 */
import { sql } from 'kysely';
import { AppError, isUuid } from '../m01_platform/index.js';
import { foldConsent } from './ledger.js';
import { ledgerDb, listEvents, minimiseAccountLedger } from './repo.js';
import type { ConsentAction, Purpose } from './types.js';

export interface ConsentExport {
  module: 'M06';
  current: Array<{ purpose: Purpose; granted: boolean; at: string; noticeVersion: string }>;
  history: Array<{
    id: string;
    memberId: string | null;
    purpose: Purpose;
    action: ConsentAction;
    noticeVersion: string;
    channel: string;
    ip: string | null;
    at: string;
  }>;
}

export async function exportConsent(accountId: string): Promise<ConsentExport> {
  if (!isUuid(accountId)) throw new AppError('VALIDATION', 'accountId must be a uuid');
  const events = await listEvents(accountId);
  const state = foldConsent(events);
  const current = (Object.keys(state) as Purpose[]).map((purpose) => {
    const s = state[purpose]!;
    return { purpose, granted: s.granted, at: s.at.toISOString(), noticeVersion: s.noticeVersion };
  });
  return {
    module: 'M06',
    current,
    history: events.map((e) => ({
      id: e.id,
      memberId: e.memberId,
      purpose: e.purpose,
      action: e.action,
      noticeVersion: e.noticeVersion,
      channel: e.channel,
      ip: e.ip,
      at: e.at.toISOString(),
    })),
  };
}

/** Refuses with CONFLICT while the account is still active. Returns the number of rows minimised. */
export async function eraseConsent(accountId: string): Promise<{ rowsMinimised: number; retained: true }> {
  if (!isUuid(accountId)) throw new AppError('VALIDATION', 'accountId must be a uuid');
  const res = await sql<{ status: string }>`select status from serving.account where id = ${accountId}`.execute(
    ledgerDb('data rights: account status'),
  );
  const status = res.rows[0]?.status;
  if (status === undefined) throw new AppError('NOT_FOUND', 'Account not found');
  if (status === 'active') throw new AppError('CONFLICT', 'Close the account before erasing consent data', { status });
  const rowsMinimised = await minimiseAccountLedger(accountId);
  return { rowsMinimised, retained: true };
}
