/**
 * M17 serving-plane tests (no network, no database): the IF-17a client fails closed, maps results
 * and errors, and the possible-match payload schema accepts what the knowledge plane sends.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { AppError, type ActorContext, type Entitlements } from '../m01_platform/index.js';
import {
  assertSanctionsClear,
  configureSanctionsClient,
  resetSanctionsClientForTesting,
  screen,
  screenDetailed,
  screenOrUnknown,
  type SanctionsTransport,
} from './client.js';
import { possibleMatchPayloadSchema } from './review.js';

const ENT: Entitlements = {
  plan: 'free',
  searchResultCap: 20,
  exportRowsPerMonth: 0,
  bulkRevealMax: 0,
  checksPerMonth: 0,
  revealsIncludedPerMonth: 0,
};

const CTX: ActorContext = {
  kind: 'user',
  entitlements: ENT,
  locale: 'en',
  region: 'IN',
  mfaVerified: false,
  correlationId: 'corr-m17-test',
};

const COMPANY = '01890000-0000-7000-8000-000000000001';

function transport(status: number, body: unknown, seen?: { url?: string; body?: string; headers?: Record<string, string> }): SanctionsTransport {
  return async (url, init) => {
    if (seen) {
      seen.url = url;
      seen.body = init.body;
      seen.headers = init.headers;
    }
    return { status, json: async () => body };
  };
}

function use(t: SanctionsTransport, timeoutMs = 500): void {
  configureSanctionsClient({ baseUrl: 'http://kp.test', token: () => 'tok', timeoutMs, transport: t });
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof AppError && e.code === code);
}

describe('m17 client', () => {
  afterEach(() => resetSanctionsClientForTesting());

  test('returns the result and sends token, correlation id and body', async () => {
    const seen: { url?: string; body?: string; headers?: Record<string, string> } = {};
    use(transport(200, { result: 'hit', listVersions: { un: 'v1' }, screenedAt: '2026-09-25T00:00:00Z' }, seen));
    const d = await screenDetailed(CTX, { companyId: COMPANY.toUpperCase() });
    assert.equal(d.result, 'hit');
    assert.equal(d.screenedAt.toISOString(), '2026-09-25T00:00:00.000Z');
    assert.equal(seen.url, 'http://kp.test/rpc/sanctions/screen');
    assert.deepEqual(JSON.parse(seen.body ?? '{}'), { companyId: COMPANY });
    assert.equal(seen.headers?.['x-internal-token'], 'tok');
    assert.equal(seen.headers?.['x-correlation-id'], 'corr-m17-test');
  });

  test('fails closed on 5xx, bad responses and network errors', async () => {
    use(transport(503, { error: { code: 'UPSTREAM_UNAVAILABLE' } }));
    await rejectsWith(screen(CTX, { companyId: COMPANY }), 'UPSTREAM_UNAVAILABLE');
    use(transport(200, { result: 'maybe' }));
    await rejectsWith(screen(CTX, { companyId: COMPANY }), 'UPSTREAM_UNAVAILABLE');
    use(async () => {
      throw new Error('ECONNREFUSED');
    });
    await rejectsWith(screen(CTX, { name: 'Acme' }), 'UPSTREAM_UNAVAILABLE');
  });

  test('fails closed on timeout', async () => {
    use(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      100,
    );
    await rejectsWith(screen(CTX, { companyId: COMPANY }), 'UPSTREAM_UNAVAILABLE');
  });

  test('maps 400 and 404', async () => {
    use(transport(400, { error: { code: 'VALIDATION' } }));
    await rejectsWith(screen(CTX, { name: 'Acme' }), 'VALIDATION');
    use(transport(404, { error: { code: 'NOT_FOUND' } }));
    await rejectsWith(screen(CTX, { companyId: COMPANY }), 'NOT_FOUND');
  });

  test('validates input before calling', async () => {
    use(transport(200, {}));
    await rejectsWith(screen(CTX, { companyId: 'nope' }), 'VALIDATION');
    await rejectsWith(screen(CTX, { name: '  ' }), 'VALIDATION');
    await rejectsWith(screen(CTX, { name: 'Acme', country: 'IND' }), 'VALIDATION');
  });

  test('assertSanctionsClear blocks hit and possible', async () => {
    for (const result of ['hit', 'possible']) {
      use(transport(200, { result, listVersions: {}, screenedAt: '2026-09-25T00:00:00Z' }));
      await rejectsWith(assertSanctionsClear(CTX, COMPANY), 'SANCTIONS_BLOCKED');
    }
    use(transport(200, { result: 'clear', listVersions: {}, screenedAt: '2026-09-25T00:00:00Z' }));
    await assertSanctionsClear(CTX, COMPANY);
  });

  test('screenOrUnknown degrades to unknown', async () => {
    use(transport(500, {}));
    assert.equal(await screenOrUnknown(CTX, { name: 'Acme' }), 'unknown');
  });
});

describe('m17 possible-match payload', () => {
  test('accepts the knowledge-plane job payload', () => {
    const p = possibleMatchPayloadSchema.safeParse({
      companyId: COMPANY,
      companyName: 'Sirius Trading House',
      country: 'IN',
      bestScore: 91.2,
      matches: [{ entryId: COMPANY, list: 'eu', listUid: '13', name: 'Sirius Trade Holding', score: 91.2 }],
      listVersions: { eu: '2026-09-21T10:00:00' },
      screenedAt: '2026-09-25T00:00:00+00:00',
    });
    assert.equal(p.success, true);
  });
});
