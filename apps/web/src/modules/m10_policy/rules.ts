/**
 * M10 — the rule pipeline as pure functions (LLD M10 "Rule pipeline"). The SQL in
 * readModelStore.ts applies rules 1, 5 and 6 set-based for search; these functions apply every
 * rule per company so byIds / assertAllowed and the unit tests share one implementation.
 *
 * Order: 1 global suppression → 2 sanctions → 3 licence → 4 region / personal data →
 *        5 logistics default hide → 6 per-user hides → 7 plan entitlements.
 */
import type { Entitlements } from '../m01_platform/index.js';
import type { SourceEntry } from '../m08_sources/index.js';
import { regionAllowed } from '../m08_sources/index.js';
import { ALL_ACTIONS, type Action, type DocFact, type PolicyDecision, type ReasonCode, type Surface } from './types.js';

/** Control fields in `field_sources` that are policy inputs, not displayable content. */
export const CONTROL_FIELDS: ReadonlySet<string> = new Set(['sanctions_block', 'is_logistics']);

/** Fields an anonymous visitor may see on a search row (rule 7). */
export const ANONYMOUS_VISIBLE_FIELDS: ReadonlySet<string> = new Set(['name', 'country', 'buyer_type', 'trust.level']);

export interface RuleInput {
  surface: Surface;
  anonymous: boolean;
  entitlements: Entitlements;
  /** Rule 1: any identifier hash of the company is on the suppression list. */
  suppressed: boolean;
  /** Rule 2. */
  sanctionsBlock: boolean;
  /** The company is closed (profile doc status). */
  closed: boolean;
  /** Rule 3/4 inputs, from the projected doc. */
  fieldSources: Record<string, string[]>;
  facts: ReadonlyMap<string, DocFact>;
  nonExportableAssertionIds: ReadonlySet<string>;
  /** Source register entries for every source id referenced by `facts` (null = unregistered). */
  sources: ReadonlyMap<string, SourceEntry | null>;
  /** The actor's region (ISO alpha-2). */
  region: string;
  /** Rule 5. */
  isLogistics: boolean;
  includeLogistics: boolean;
  /** Rule 6. */
  userHidden: boolean;
  hiddenAssertionIds: ReadonlySet<string>;
}

function hidden(reason: ReasonCode): PolicyDecision {
  return { visibility: 'hidden', allowed: [], redactedFields: [], reasons: [reason] };
}

class DecisionBuilder {
  visibility: PolicyDecision['visibility'] = 'visible';
  allowed = new Set<Action>(ALL_ACTIONS);
  redacted = new Set<string>();
  reasons: ReasonCode[] = [];

  reason(r: ReasonCode): void {
    if (!this.reasons.includes(r)) this.reasons.push(r);
  }

  restrictTo(actions: readonly Action[]): void {
    for (const a of [...this.allowed]) if (!actions.includes(a)) this.allowed.delete(a);
  }

  redact(field: string, r: ReasonCode): void {
    this.redacted.add(field);
    this.reason(r);
  }

  build(): PolicyDecision {
    return {
      visibility: this.visibility,
      allowed: ALL_ACTIONS.filter((a) => this.allowed.has(a)),
      redactedFields: [...this.redacted].sort(),
      reasons: this.reasons,
    };
  }
}

function contentFields(fieldSources: Record<string, string[]>): Array<[string, string[]]> {
  return Object.entries(fieldSources).filter(([f, ids]) => !CONTROL_FIELDS.has(f) && Array.isArray(ids));
}

/** Rule 1. */
export function ruleSuppression(input: Pick<RuleInput, 'suppressed'>): PolicyDecision | null {
  return input.suppressed ? hidden('SUPPRESSED') : null;
}

/** Rule 2: sanctions-flagged companies stay visible with a warning; only `view` is allowed. */
export function ruleSanctions(b: DecisionBuilder, input: Pick<RuleInput, 'sanctionsBlock'>): void {
  if (!input.sanctionsBlock) return;
  b.visibility = 'visible_with_warning';
  b.restrictTo(['view']);
  b.reason('SANCTIONS_BLOCK');
}

/** Closed companies keep their profile (status: closed) but nothing can be acted on. */
export function ruleClosed(b: DecisionBuilder, input: Pick<RuleInput, 'closed'>): void {
  if (!input.closed) return;
  b.restrictTo(['view']);
  b.reason('CLOSED');
}

/**
 * Rule 3: licence. The doc already excludes non-displayable facts; on `export` every field
 * backed by a `can_export=false` assertion is redacted. Facts from sources that are now
 * prohibited or no longer displayable are redacted on every surface (defence in depth).
 */
export function ruleLicence(
  b: DecisionBuilder,
  input: Pick<RuleInput, 'surface' | 'fieldSources' | 'facts' | 'nonExportableAssertionIds' | 'sources'>,
): void {
  for (const [field, ids] of contentFields(input.fieldSources)) {
    let redact = false;
    for (const id of ids) {
      if (input.surface === 'export') {
        const fact = input.facts.get(id);
        if (input.nonExportableAssertionIds.has(id) || (fact !== undefined && !fact.can_export)) redact = true;
      }
      const fact = input.facts.get(id);
      if (fact) {
        const src = input.sources.get(fact.source_id);
        if (src && (src.status === 'prohibited' || !src.canDisplay || (input.surface === 'export' && !src.canExport))) {
          redact = true;
        }
      }
      if (redact) break;
    }
    if (redact) b.redact(field, 'LICENCE_REDACTED');
  }
}

/**
 * Rule 4: region and personal data. `named_person` data is always redacted. A field is also
 * redacted when a backing fact's source does not allow the actor's region, or the source is
 * not in the register at all (fail closed).
 */
export function ruleRegion(b: DecisionBuilder, input: Pick<RuleInput, 'fieldSources' | 'facts' | 'sources' | 'region'>): void {
  for (const [field, ids] of contentFields(input.fieldSources)) {
    let redact = false;
    for (const id of ids) {
      const fact = input.facts.get(id);
      if (!fact) continue;
      if (fact.personal_data_class === 'named_person') {
        redact = true;
        break;
      }
      if (!input.sources.has(fact.source_id)) continue; // not looked up: nothing region-restricted is registered
      const src = input.sources.get(fact.source_id) ?? null;
      if (src === null || !regionAllowed(src, input.region)) {
        redact = true;
        break;
      }
    }
    if (redact) b.redact(field, 'REGION_REDACTED');
  }
}

/** Rule 5: logistics entities are hidden unless the caller opted in (REQ-020). */
export function ruleLogistics(input: Pick<RuleInput, 'isLogistics' | 'includeLogistics'>): PolicyDecision | null {
  return input.isLogistics && !input.includeLogistics ? hidden('LOGISTICS_DEFAULT_HIDDEN') : null;
}

/** Rule 6: per-user hides (REQ-025). Hidden companies disappear; hidden facts are redacted. */
export function ruleUserHides(
  b: DecisionBuilder | null,
  input: Pick<RuleInput, 'userHidden' | 'hiddenAssertionIds' | 'fieldSources'>,
): PolicyDecision | null {
  if (input.userHidden) return hidden('USER_HIDDEN');
  if (b && input.hiddenAssertionIds.size > 0) {
    for (const [field, ids] of contentFields(input.fieldSources)) {
      if (ids.some((id) => input.hiddenAssertionIds.has(id))) b.redact(field, 'USER_HIDDEN');
    }
  }
  return null;
}

/**
 * Rule 7: plan entitlements (REQ-051). Anonymous visitors may only view, and on search see only
 * name, country, buyer type and trust level. Plans without export rows cannot export. The
 * result cap is applied by the caller (search), which knows the totals.
 */
export function rulePlan(b: DecisionBuilder, input: Pick<RuleInput, 'anonymous' | 'entitlements' | 'surface' | 'fieldSources'>): void {
  if (input.anonymous) {
    if ([...b.allowed].some((a) => a !== 'view')) b.reason('PLAN_LIMIT');
    b.restrictTo(['view']);
    if (input.surface === 'search') {
      for (const field of Object.keys(input.fieldSources)) {
        if (!ANONYMOUS_VISIBLE_FIELDS.has(field) && !CONTROL_FIELDS.has(field)) b.redacted.add(field);
      }
    }
    return;
  }
  if (input.entitlements.exportRowsPerMonth <= 0 && b.allowed.has('export')) {
    b.allowed.delete('export');
    b.reason('PLAN_LIMIT');
  }
}

/** Runs the whole pipeline for one company. */
export function evaluate(input: RuleInput): PolicyDecision {
  const suppressed = ruleSuppression(input);
  if (suppressed) return suppressed;
  const b = new DecisionBuilder();
  ruleSanctions(b, input);
  ruleClosed(b, input);
  ruleLicence(b, input);
  ruleRegion(b, input);
  const logistics = ruleLogistics(input);
  if (logistics) return logistics;
  const userHidden = ruleUserHides(b, input);
  if (userHidden) return userHidden;
  rulePlan(b, input);
  return b.build();
}

/** Whether `decision` permits `action`. */
export function permits(decision: PolicyDecision, action: Action): boolean {
  return decision.visibility !== 'hidden' && decision.allowed.includes(action);
}

/** Assertion ids behind a set of redacted fields. */
export function redactedAssertionIds(fieldSources: Record<string, string[]>, fields: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const f of fields) for (const id of fieldSources[f] ?? []) out.add(id);
  return out;
}

export { DecisionBuilder };
