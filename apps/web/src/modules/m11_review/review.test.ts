/**
 * M11 unit tests (no database): type registration and validation, RBAC per type, SLA
 * computation and overrides, row mapping, dead-letter payloads, console guard (MFA).
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { z } from 'zod';
import { AppError, type ActorContext, type Entitlements, type Id } from '../m01_platform/index.js';
import { resetRegistriesForTesting, type DeadLetterInfo } from '../m02_queue/index.js';
import { deadLetterPayloadOf, deadLetterPayloadSchema, registerReviewModule, resetReviewModuleForTesting } from './jobs.js';
import {
  configureReviewSla,
  getType,
  registeredTypes,
  resetReviewRegistryForTesting,
  roleMayHandle,
  slaDueAt,
  typesVisibleTo,
} from './registry.js';
import { rowToItem, type ReviewItemRow } from './repo.js';
import { listItems, registerType, reviewOutcomeEventType } from './service.js';
import { reviewActor } from './writeback.js';

const ENT: Entitlements = {
  plan: 'free',
  searchResultCap: 20,
  exportRowsPerMonth: 0,
  bulkRevealMax: 0,
  checksPerMonth: 0,
  revealsIncludedPerMonth: 0,
};

function ctx(over: Partial<ActorContext>): ActorContext {
  return { kind: 'admin', entitlements: ENT, locale: 'en', region: 'IN', mfaVerified: true, correlationId: 'c1', ...over };
}

function reportDef(type = 'test.report') {
  return {
    type,
    payloadSchema: z.object({ companyId: z.string().uuid(), reason: z.string() }),
    outcomes: ['accept', 'dismiss'] as const,
    rejectingOutcomes: ['dismiss'] as const,
    outcomeSchema: z.object({ note: z.string().optional() }),
    slaHours: 120,
    requiredRole: 'admin_support' as const,
    view: { titleKey: 'admin.review.report.title', fields: [{ path: 'reason', labelKey: 'admin.review.report.reason' }] },
    onOutcome: async () => {},
  };
}

beforeEach(() => {
  resetReviewModuleForTesting();
  resetReviewRegistryForTesting();
  resetRegistriesForTesting();
});

describe('registerType', () => {
  test('registers and exposes the type', () => {
    registerType(reportDef());
    assert.ok(getType('test.report'));
    assert.equal(registeredTypes().length, 1);
    assert.equal(reviewOutcomeEventType('test.report'), 'review.outcome.test.report');
  });

  test('rejects duplicates, bad names, empty outcomes and bad SLA', () => {
    registerType(reportDef());
    assert.throws(() => registerType(reportDef()), (e: unknown) => e instanceof AppError && e.code === 'CONFLICT');
    assert.throws(() => registerType({ ...reportDef('Bad Name') }), AppError);
    assert.throws(() => registerType({ ...reportDef('x.empty'), outcomes: [] }), AppError);
    assert.throws(() => registerType({ ...reportDef('x.sla'), slaHours: 0 }), AppError);
    assert.throws(() => registerType({ ...reportDef('x.rej'), rejectingOutcomes: ['nope'] }), AppError);
  });
});

describe('RBAC', () => {
  test('support sees reports; ops sees dead letters; super sees all', () => {
    registerType(reportDef());
    registerReviewModule();
    registerType({ ...reportDef('billing.refund_over_cap'), requiredRole: undefined });
    assert.deepEqual(typesVisibleTo('admin_support').sort(), ['test.report']);
    assert.deepEqual(typesVisibleTo('admin_ops').sort(), ['system.dead_letter', 'test.report']);
    assert.equal(typesVisibleTo('admin_super').length, 3);
    const refund = getType('billing.refund_over_cap');
    assert.ok(refund);
    assert.equal(roleMayHandle('admin_ops', refund), false);
  });

  test('console refuses admins without MFA and non-admins', async () => {
    await assert.rejects(listItems(ctx({ mfaVerified: false, role: 'admin_super', memberId: 'x' as Id<'member'> }), {}), (e: unknown) => e instanceof AppError && e.code === 'FORBIDDEN');
    await assert.rejects(listItems(ctx({ kind: 'anonymous' }), {}), (e: unknown) => e instanceof AppError && e.code === 'UNAUTHENTICATED');
  });

  test('support may not filter on an ops-only type', async () => {
    registerReviewModule();
    const c = ctx({ role: 'admin_support', memberId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as Id<'member'> });
    await assert.rejects(listItems(c, { type: 'system.dead_letter' }), (e: unknown) => e instanceof AppError && e.code === 'FORBIDDEN');
  });
});

describe('SLA', () => {
  test('due date uses slaHours and runtime overrides', () => {
    registerType(reportDef());
    const def = getType('test.report');
    assert.ok(def);
    const from = new Date('2026-01-01T00:00:00Z');
    assert.equal(slaDueAt(def, from).toISOString(), '2026-01-06T00:00:00.000Z');
    configureReviewSla({ 'test.report': 72 });
    assert.equal(slaDueAt(def, from).toISOString(), '2026-01-04T00:00:00.000Z');
    configureReviewSla({ 'test.report': null });
    assert.equal(slaDueAt(def, from).toISOString(), '2026-01-06T00:00:00.000Z');
    assert.throws(() => configureReviewSla({ 'test.report': -1 }), AppError);
  });

  test('rowToItem flags breaches only for active items', () => {
    const base: ReviewItemRow = {
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      type: 'test.report',
      subject_refs: [{ kind: 'company', id: 'c1' }, { bad: true }],
      payload: '{"reason":"x"}',
      filed_by_kind: 'user',
      filed_by_ref: null,
      state: 'open',
      assignee: null,
      sla_due_at: '2026-01-01T00:00:00Z',
      outcome: null,
      outcome_payload: null,
      handler_result: null,
      handler_error: null,
      resolved_by: null,
      resolved_at: null,
      dedupe_key: null,
      created_at: '2025-12-30T00:00:00Z',
      updated_at: '2025-12-30T00:00:00Z',
    };
    const now = new Date('2026-01-02T00:00:00Z');
    const open = rowToItem(base, now);
    assert.equal(open.slaBreached, true);
    assert.deepEqual(open.subjectRefs, [{ kind: 'company', id: 'c1' }]);
    assert.deepEqual(open.payload, { reason: 'x' });
    const done = rowToItem({ ...base, state: 'resolved', outcome: 'accept' }, now);
    assert.equal(done.slaBreached, false);
  });
});

describe('dead letters', () => {
  test('dead-letter info maps to a valid payload', () => {
    const info: DeadLetterInfo = {
      jobId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as Id<'job'>,
      type: 'm09.project',
      queue: 'knowledge',
      payload: { company_id: 'x' },
      attempts: 8,
      maxAttempts: 8,
      lastError: 'e'.repeat(10_000),
      correlationId: 'corr',
      actorRef: null,
      reason: 'max_attempts',
    };
    const p = deadLetterPayloadOf(info);
    assert.equal(p.lastError.length, 4000);
    assert.equal(deadLetterPayloadSchema.safeParse(p).success, true);
  });

  test('review actor falls back to system', () => {
    assert.equal(reviewActor({ resolvedBy: null }), 'system:m11');
    assert.equal(reviewActor({ resolvedBy: 'abc' }), 'admin:abc');
  });
});
