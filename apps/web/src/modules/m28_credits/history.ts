/**
 * M28 — usage history (`GET /api/credits/history?cursor=`), grouped by txn_id (LLD M28 rule).
 * Cursor-paginated, newest first; the cursor encodes (created_at, txn_id) of the last row shown.
 * Every entry in one txn_id shares the same created_at (Postgres `now()` is stable for the whole
 * transaction that wrote them), so grouping by (txn_id, that shared created_at) is exact.
 */
import { sql } from 'kysely';
import { AppError, type ActorContext } from '../m01_platform/index.js';
import { mapEntry } from './ledger.js';
import { userExec } from './exec.js';
import type { UsageHistoryPage, UsageTxn } from './types.js';

const PAGE_SIZE = 20;

function encodeCursor(createdAt: Date, txnId: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${txnId}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; txnId: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new AppError('VALIDATION', 'Malformed cursor', { field: 'cursor' });
  }
  const idx = decoded.lastIndexOf('|');
  if (idx < 0) throw new AppError('VALIDATION', 'Malformed cursor', { field: 'cursor' });
  const createdAt = new Date(decoded.slice(0, idx));
  const txnId = decoded.slice(idx + 1);
  if (Number.isNaN(createdAt.getTime()) || txnId.length === 0) throw new AppError('VALIDATION', 'Malformed cursor', { field: 'cursor' });
  return { createdAt, txnId };
}

/** IF-28's usage-history rule: `GET /api/credits/history?cursor` returns entries grouped by txn_id. */
export async function usageHistory(ctx: ActorContext, cursor: string | null): Promise<UsageHistoryPage> {
  const { exec, accountId } = userExec(ctx);
  const after = cursor ? decodeCursor(cursor) : null;

  const grouped = await exec.run(
    after
      ? sql<{ txn_id: string; created_at: unknown }>`
          select txn_id, max(created_at) as created_at
          from ledger.entry
          where account_id = ${accountId}
          group by txn_id
          having (max(created_at), txn_id) < (${after.createdAt}, ${after.txnId})
          order by created_at desc, txn_id desc
          limit ${PAGE_SIZE}
        `
      : sql<{ txn_id: string; created_at: unknown }>`
          select txn_id, max(created_at) as created_at
          from ledger.entry
          where account_id = ${accountId}
          group by txn_id
          order by created_at desc, txn_id desc
          limit ${PAGE_SIZE}
        `,
  );
  if (grouped.length === 0) return { items: [], nextCursor: null };

  const txnIds = grouped.map((g) => String(g.txn_id));
  const entryRows = await exec.run(sql<Record<string, unknown>>`
    select * from ledger.entry where account_id = ${accountId} and txn_id in (${sql.join(txnIds)}) order by created_at desc, id asc
  `);

  const byTxn = new Map<string, UsageTxn>();
  for (const g of grouped) {
    byTxn.set(String(g.txn_id), {
      txnId: String(g.txn_id),
      createdAt: new Date(g.created_at as string | number | Date).toISOString(),
      netCredits: 0,
      entries: [],
    });
  }
  for (const raw of entryRows) {
    const e = mapEntry(raw);
    const group = byTxn.get(e.txnId);
    if (!group) continue;
    group.entries.push({
      id: e.id,
      kind: e.kind,
      bucket: e.bucket,
      credits: e.credits,
      actionType: e.actionType,
      actionRef: e.actionRef,
      catalogueVersion: e.catalogueVersion,
      refersTo: e.refersTo,
      createdAt: e.createdAt.toISOString(),
    });
    if (e.bucket === 'available') group.netCredits += e.credits;
  }

  const items = grouped.map((g) => byTxn.get(String(g.txn_id))!);
  const last = grouped[grouped.length - 1]!;
  const nextCursor = grouped.length === PAGE_SIZE ? encodeCursor(new Date(last.created_at as string | number | Date), String(last.txn_id)) : null;
  return { items, nextCursor };
}
