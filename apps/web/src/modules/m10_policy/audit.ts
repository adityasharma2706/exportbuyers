/**
 * M10 — serving.policy_audit: a 1% [tunable] sample of decisions plus every deny on the
 * reveal / draft / export surfaces. Audit writes never fail the read that triggered them.
 */
import { sql } from 'kysely';
import { isUuid, log, newId, systemDb, type ActorContext } from '../m01_platform/index.js';
import { policyConfig } from './providers.js';
import type { PolicyDecision, Surface } from './types.js';

export const ALWAYS_AUDIT_DENY_SURFACES: ReadonlySet<Surface> = new Set<Surface>(['reveal', 'draft', 'export']);

export interface AuditItem {
  companyId: string;
  decision: PolicyDecision;
  /** True when the requested action was refused. */
  denied: boolean;
}

export function shouldAudit(surface: Surface, denied: boolean, rand: () => number = Math.random): boolean {
  if (denied && ALWAYS_AUDIT_DENY_SURFACES.has(surface)) return true;
  return rand() < policyConfig().auditSampleRate;
}

export async function recordDecisions(ctx: ActorContext, surface: Surface, items: readonly AuditItem[]): Promise<void> {
  const rows = items
    .filter((i) => isUuid(i.companyId) && shouldAudit(surface, i.denied))
    .map((i) => ({
      id: newId<'policy_audit'>(),
      company_id: i.companyId,
      decision: JSON.stringify({ ...i.decision, denied: i.denied, actorKind: ctx.kind, correlationId: ctx.correlationId }),
    }));
  if (rows.length === 0) return;
  const accountId = ctx.accountId && isUuid(ctx.accountId) ? ctx.accountId : null;
  try {
    await sql`
      insert into serving.policy_audit (id, account_id, surface, company_id, decision, at)
      select t.id, ${accountId}::uuid, ${surface}, t.company_id, t.decision::jsonb, now()
        from unnest(${rows.map((r) => r.id)}::uuid[], ${rows.map((r) => r.company_id)}::uuid[], ${rows.map((r) => r.decision)}::text[])
             as t(id, company_id, decision)`.execute(systemDb('m10 policy audit write'));
  } catch (err) {
    log.error({ err, surface, rows: rows.length, correlationId: ctx.correlationId }, 'm10 policy audit write failed');
  }
}
