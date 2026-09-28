/**
 * M38 — the `m38.export` job (LLD M38 "Rules: Export").
 *   "run every contributor's export as a job. Zip the results to S3 and keep them 7 days; the
 *   download link is pre-signed for 24 h. Notify the user by email."
 */
import archiver from 'archiver';
import { AppError, log, objectStore, withSpan } from '../m01_platform/index.js';
import { registerHandler, registerRateClass, type PayloadSchema } from '../m02_queue/index.js';
import { sendTransactionalEmail } from '../m05_identity/index.js';
import { exportIdentity } from '../m05_identity/index.js';
import { dataRightsConfig, EXPORT_JOB_TYPE, RIGHTS_RATE_CLASS } from './config.js';
import { listContributorsOrdered } from './registry.js';
import { markRequestDone, setRequestState } from './repo.js';

export interface ExportJobPayload {
  v: 1;
  requestId: string;
  accountId: string;
}

const schema: PayloadSchema<ExportJobPayload> = {
  safeParse(input: unknown) {
    if (input === null || typeof input !== 'object') return { success: false, error: { message: 'payload must be an object' } };
    const o = input as Record<string, unknown>;
    if (o.v !== 1 || typeof o.requestId !== 'string' || typeof o.accountId !== 'string') {
      return { success: false, error: { message: 'payload must be {v:1, requestId, accountId}' } };
    }
    return { success: true, data: { v: 1, requestId: o.requestId, accountId: o.accountId } };
  },
};

function keyFor(accountId: string, requestId: string): string {
  return `${dataRightsConfig().keyPrefix}/${accountId}/${requestId}.zip`;
}

async function buildZip(accountId: string, requestId: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('error', (e: unknown) => reject(e));
  });

  for (const contributor of listContributorsOrdered()) {
    let result: Awaited<ReturnType<typeof contributor.export>>;
    try {
      result = await contributor.export(accountId);
    } catch (err) {
      log.error({ err, accountId, requestId, contributor: contributor.module }, 'm38: export contributor failed');
      throw err instanceof AppError ? err : new AppError('INTERNAL', `Export contributor ${contributor.module} failed`, undefined, { cause: err });
    }
    for (const file of result.files) {
      archive.append(JSON.stringify(file.json, null, 2), { name: `${contributor.module.toLowerCase()}/${file.name}` });
    }
  }
  archive.append(
    JSON.stringify({ accountId, requestId, generatedAt: new Date().toISOString(), note: 'ExportBuyers account data export (DPDP data right)' }, null, 2),
    { name: 'README.json' },
  );
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

export async function runExport(payload: ExportJobPayload): Promise<void> {
  const { accountId, requestId } = payload;
  await withSpan(
    'm38.export',
    async () => {
      await setRequestState(requestId, 'running');
      const zip = await buildZip(accountId, requestId);
      const key = keyFor(accountId, requestId);
      const expiresAt = new Date(Date.now() + dataRightsConfig().exportRetentionDays * 24 * 60 * 60 * 1000);
      await objectStore().put(key, zip, 'application/zip', { 'account-id': accountId, 'expires-at': expiresAt.toISOString() });
      await markRequestDone(requestId, key, new Date());

      const identity = await exportIdentity(accountId);
      const to = identity.members.find((m) => m.email)?.email ?? null;
      if (to) {
        await sendTransactionalEmail(to, 'data_export_ready', { requestId }, { idempotencyKey: `m38.export:${requestId}` }).catch((e: unknown) =>
          log.warn({ err: e, accountId, requestId }, 'm38: could not notify the user their export is ready'),
        );
      }
      log.info({ accountId, requestId, key }, 'm38: export complete');
    },
    { accountId, requestId },
  ).catch(async (err: unknown) => {
    await setRequestState(requestId, 'failed').catch((e: unknown) => log.error({ err: e, requestId }, 'm38: failed to mark export request failed'));
    throw err;
  });
}

let registered = false;

/** Registers M38's `m38.export` job handler. Call once at worker boot. */
export function registerExportJob(): void {
  if (registered) return;
  registerRateClass(RIGHTS_RATE_CLASS, 4, 2);
  registerHandler(EXPORT_JOB_TYPE, schema, async (payload) => {
    await runExport(payload);
  });
  registered = true;
}

/** For tests. */
export function resetExportJobForTesting(): void {
  registered = false;
}
