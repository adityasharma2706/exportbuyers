/**
 * M39 — cost-per-credit dashboard (LLD M39 #5): "a SQL view `analytics.v_cost_per_credit` = sum
 * of `cost_event` by `credit_ref`, joined to ledger commits" (db/migrations/0039). This module is
 * the read path over that view plus the admin route that shows it.
 *
 * [deviation: `recordCost`'s `creditRef` (M01 IF-01b) is not populated by any vendor call site
 * built so far (M03's LLM adapter, M05's SMS/email vendors) — none of them thread a
 * `ledger.entry.action_ref` through to `recordCost`. The view and this report are built exactly
 * to the LLD's spec regardless, so they are ready the moment an earlier module starts passing
 * `creditRef`; until then this report legitimately returns no rows, which the empty-state text
 * below says plainly rather than hiding.]
 */
import { sql } from 'kysely';
import { AppError, log, systemDb, toAppError, type ActorContext } from '../m01_platform/index.js';
import { requireAdmin, resolveSession, type HttpReplyLike, type HttpRequestLike } from '../m05_identity/index.js';
import { launchHardeningConfig } from './config.js';

export interface CostPerCreditRow {
  vendor: string;
  actionType: string | null;
  events: number;
  creditsCommitted: number;
  vendorCostMicrosInr: string;
  /** Micro-INR spent with the vendor per credit committed for this (vendor, actionType); null when
   * creditsCommitted is 0 (should not happen — a commit always carries credits <> 0 per M28's
   * ledger.entry check constraint — but the report degrades rather than divides by zero). */
  costMicrosInrPerCredit: number | null;
}

interface RawRow {
  vendor: string;
  action_type: string | null;
  events: string | number;
  credits: string | number;
  cost: string | number;
}

/** `analytics.v_cost_per_credit` summed by (vendor, actionType) over [from, to). */
export async function costPerCreditReport(from: Date, to: Date): Promise<CostPerCreditRow[]> {
  if (!(from instanceof Date) || !(to instanceof Date) || from >= to) {
    throw new AppError('VALIDATION', 'costPerCreditReport: from must be before to');
  }
  const res = await sql<RawRow>`
    select vendor, action_type,
           count(*)::text as events,
           coalesce(sum(credits_committed), 0)::text as credits,
           coalesce(sum(vendor_cost_micros_inr), 0)::text as cost
      from analytics.v_cost_per_credit
     where at >= ${from} and at < ${to}
     group by vendor, action_type
     order by cost desc
  `.execute(systemDb('m39: cost-per-credit report'));

  return res.rows.map((r) => {
    const credits = Number(r.credits);
    const cost = Number(r.cost);
    return {
      vendor: r.vendor,
      actionType: r.action_type,
      events: Number(r.events),
      creditsCommitted: credits,
      vendorCostMicrosInr: String(r.cost),
      costMicrosInrPerCredit: credits > 0 ? cost / credits : null,
    };
  });
}

// ---- admin route -----------------------------------------------------------------------------

export interface CostPerCreditRouteRequest extends HttpRequestLike {
  query?: unknown;
}
export interface CostPerCreditRouteReply extends HttpReplyLike {
  code(status: number): CostPerCreditRouteReply;
  send(payload?: unknown): unknown;
}
type RouteHandler = (req: CostPerCreditRouteRequest, reply: CostPerCreditRouteReply) => Promise<unknown>;
export interface CostPerCreditRouteApp {
  get(path: string, handler: RouteHandler): unknown;
}

function parseWindow(query: unknown): { from: Date; to: Date } {
  const q = (query ?? {}) as Record<string, unknown>;
  const now = new Date();
  const defaultDays = launchHardeningConfig().costPerCredit.defaultWindowDays;
  const toRaw = typeof q.to === 'string' ? new Date(q.to) : now;
  const fromRaw = typeof q.from === 'string' ? new Date(q.from) : new Date(toRaw.getTime() - defaultDays * 24 * 3600 * 1000);
  if (Number.isNaN(fromRaw.getTime()) || Number.isNaN(toRaw.getTime()) || fromRaw >= toRaw) {
    throw new AppError('VALIDATION', 'from/to must be valid ISO dates with from < to');
  }
  return { from: fromRaw, to: toRaw };
}

/** `GET /api/admin/cost-per-credit?from&to` (admin_ops+; MFA required per M05 `requireAdmin`). */
export function registerCostPerCreditRoutes(app: CostPerCreditRouteApp): void {
  app.get('/api/admin/cost-per-credit', async (req, reply) => {
    let correlationId: string | undefined;
    try {
      const ctx: ActorContext = await resolveSession(req);
      correlationId = ctx.correlationId;
      requireAdmin(ctx, 'admin_ops');
      const { from, to } = parseWindow(req.query);
      const rows = await costPerCreditReport(from, to);
      reply.code(200);
      return reply.send({ from: from.toISOString(), to: to.toISOString(), rows });
    } catch (e) {
      const err = toAppError(e, correlationId);
      if (err.code === 'INTERNAL') log.error({ err: e, correlationId }, 'm39: cost-per-credit route failed');
      reply.code(err.http);
      return reply.send(err.toResponseBody());
    }
  });
}
