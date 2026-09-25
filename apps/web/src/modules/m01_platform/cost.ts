/**
 * M01 — per-vendor cost metrics (IF-01b).
 *
 *   recordCost({vendor, op, units, costMicrosInr, ctx?, jobType?, creditRef?}): void
 *
 * Events are buffered in memory and flushed to platform.cost_event every 5 s [tunable].
 * recordCost() never blocks and never throws for I/O reasons; it only throws VALIDATION for
 * programmer errors (bad vendor name, non-integer money) so those are caught in tests.
 *
 * Reporting helpers aggregate spend per vendor, job type, account (user) and credit ref.
 */
import { sql } from 'kysely';
import { getConfig } from './config.js';
import { systemDb } from './db.js';
import { AppError } from './errors.js';
import { newId } from './ids.js';
import { currentCorrelationId, log } from './logging.js';
import type { ActorContext } from './types.js';

export interface CostEventInput {
  vendor: string;
  op: string;
  units: number;
  /** Cost in micro-INR (1 INR = 1,000,000). Integer; never a float. */
  costMicrosInr: number;
  ctx?: ActorContext;
  jobType?: string;
  creditRef?: string;
}

interface CostRow {
  id: string;
  vendor: string;
  op: string;
  units: string;
  cost_micros_inr: string;
  job_type: string | null;
  account_id: string | null;
  credit_ref: string | null;
  correlation_id: string;
  at: Date;
}

const NAME_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

let buffer: CostRow[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let flushing: Promise<void> | undefined;
let droppedSinceLastWarn = 0;

/** Sink used by flush(); replaceable in tests. */
export type CostSink = (rows: ReadonlyArray<CostRow>) => Promise<void>;

const dbSink: CostSink = async (rows) => {
  await systemDb('m01.cost.flush').insertInto('platform.cost_event').values(rows as CostRow[]).execute();
};

let sink: CostSink = dbSink;

export function setCostSinkForTesting(s: CostSink | undefined): void {
  sink = s ?? dbSink;
}

function validate(e: CostEventInput): void {
  if (!NAME_RE.test(e.vendor)) throw new AppError('VALIDATION', `recordCost: invalid vendor "${e.vendor}"`);
  if (!NAME_RE.test(e.op)) throw new AppError('VALIDATION', `recordCost: invalid op "${e.op}"`);
  if (!Number.isFinite(e.units) || e.units < 0) throw new AppError('VALIDATION', 'recordCost: units must be a finite number >= 0');
  if (!Number.isSafeInteger(e.costMicrosInr) || e.costMicrosInr < 0) {
    throw new AppError('VALIDATION', 'recordCost: costMicrosInr must be a non-negative integer (micro-INR)');
  }
  if (e.jobType !== undefined && !NAME_RE.test(e.jobType)) {
    throw new AppError('VALIDATION', `recordCost: invalid jobType "${e.jobType}"`);
  }
  if (e.creditRef !== undefined && (e.creditRef.length === 0 || e.creditRef.length > 200)) {
    throw new AppError('VALIDATION', 'recordCost: creditRef must be 1..200 chars');
  }
}

/** IF-01b. Buffered; flushed every flushIntervalMs. */
export function recordCost(e: CostEventInput): void {
  validate(e);
  const cfg = getConfig();
  if (buffer.length >= cfg.cost.maxBufferedEvents) {
    // Back-pressure: DB unreachable for a long time. Drop the oldest so memory stays bounded.
    buffer.shift();
    droppedSinceLastWarn += 1;
  }
  buffer.push({
    id: newId<'cost_event'>(),
    vendor: e.vendor,
    op: e.op,
    units: String(e.units),
    cost_micros_inr: String(e.costMicrosInr),
    job_type: e.jobType ?? null,
    account_id: e.ctx?.accountId ?? null,
    credit_ref: e.creditRef ?? null,
    correlation_id: e.ctx?.correlationId ?? currentCorrelationId() ?? 'none',
    at: new Date(),
  });
  ensureTimer();
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushCosts();
  }, getConfig().cost.flushIntervalMs);
  timer.unref();
}

/** Writes all buffered events. Concurrent callers share the in-flight flush. */
export function flushCosts(): Promise<void> {
  if (flushing) return flushing;
  if (buffer.length === 0) return Promise.resolve();
  const batch = buffer;
  buffer = [];
  flushing = (async () => {
    try {
      if (droppedSinceLastWarn > 0) {
        log.warn({ dropped: droppedSinceLastWarn }, 'cost events dropped due to full buffer');
        droppedSinceLastWarn = 0;
      }
      for (let i = 0; i < batch.length; i += 500) {
        await sink(batch.slice(i, i + 500));
      }
    } catch (err) {
      // Put the batch back in front of anything recorded meanwhile; cap total size.
      const max = getConfig().cost.maxBufferedEvents;
      const merged = batch.concat(buffer);
      const overflow = Math.max(0, merged.length - max);
      droppedSinceLastWarn += overflow;
      buffer = merged.slice(overflow);
      log.error({ err, pending: buffer.length }, 'cost flush failed; will retry');
    } finally {
      flushing = undefined;
    }
  })();
  return flushing;
}

/** Stops the timer and performs a final flush (graceful shutdown). */
export async function stopCostRecorder(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  if (flushing) await flushing;
  await flushCosts();
}

export function pendingCostEvents(): number {
  return buffer.length;
}

// ---------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------

export type CostGroupBy = 'vendor' | 'job_type' | 'account_id' | 'credit_ref';

export interface CostReportRow {
  vendor: string;
  key: string | null;
  events: number;
  units: number;
  costMicrosInr: bigint;
}

/**
 * Spend in [from, to) grouped by vendor plus one more dimension:
 * per job type, per user (account), or per credit ref.
 */
export async function costReport(args: { from: Date; to: Date; groupBy: CostGroupBy; vendor?: string }): Promise<CostReportRow[]> {
  if (!(args.from instanceof Date) || !(args.to instanceof Date) || args.from >= args.to) {
    throw new AppError('VALIDATION', 'costReport: from must be before to');
  }
  const col = sql.ref(`cost_event.${args.groupBy}`);
  const vendorCol = sql.ref('cost_event.vendor');
  const q = sql`
    select ${vendorCol} as vendor,
           ${args.groupBy === 'vendor' ? sql`null::text` : sql`${col}::text`} as key,
           count(*)::text as events,
           coalesce(sum(units), 0)::text as units,
           coalesce(sum(cost_micros_inr), 0)::text as cost
      from platform.cost_event
     where at >= ${args.from} and at < ${args.to}
       ${args.vendor ? sql`and vendor = ${args.vendor}` : sql``}
     group by 1, 2
     order by sum(cost_micros_inr) desc`;
  const res = await q.execute(systemDb(`m01.cost.report:${args.groupBy}`));
  return (res.rows as Array<{ vendor: string; key: string | null; events: string; units: string; cost: string }>).map((r) => ({
    vendor: r.vendor,
    key: r.key,
    events: Number(r.events),
    units: Number(r.units),
    costMicrosInr: BigInt(r.cost),
  }));
}

/** Month-to-date spend per vendor (UTC month). Used by the budget job. */
export async function monthToDateSpend(now: Date = new Date()): Promise<Map<string, bigint>> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const res = await sql`
    select vendor, coalesce(sum(cost_micros_inr), 0)::text as cost
      from platform.cost_event
     where at >= ${start} and at <= ${now}
     group by vendor`.execute(systemDb('m01.budget.month_to_date'));
  const out = new Map<string, bigint>();
  for (const r of res.rows as Array<{ vendor: string; cost: string }>) out.set(r.vendor, BigInt(r.cost));
  return out;
}
