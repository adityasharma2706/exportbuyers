/**
 * M35 — server side (IF-35a). REQ-048.
 *
 *   createExport(ctx, body)   POST /api/exports        -> 202 {exportId}
 *   getExport(ctx, id)        GET  /api/exports/:id     -> 200 {state, rows?, downloadUrl?, expiresAt}
 *
 * LLD Job m35.build does the actual work (build.ts), asynchronously; this only records the
 * request and enqueues it (mirrors M29's revealBulk: insert a row, enqueue a job, let the UI
 * poll GET for the result).
 */
import { AppError, newId, systemDb, withSpan, type ActorContext } from '../m01_platform/index.js';
import { requireMember } from '../m05_identity/index.js';
import { enqueue, type Tx } from '../m02_queue/index.js';
import { BUILD_JOB_QUEUE, BUILD_JOB_TYPE, exportConfig } from './config.js';
import { presignExportDownload } from './presign.js';
import { findExport, insertExport } from './repo.js';
import { parseCreateExportInput, parseExportIdParam } from './validate.js';
import type { BuildJobPayload, CreateExportResponseDto, GetExportResponseDto } from './types.js';

async function enqueueBuildJob(ctx: ActorContext, payload: BuildJobPayload): Promise<void> {
  const db = systemDb('m35: enqueue an export build job');
  await db.transaction().execute(async (tx: Tx) => {
    await enqueue(tx, { type: BUILD_JOB_TYPE, queue: BUILD_JOB_QUEUE, payload, idempotencyKey: `m35.build:${payload.exportId}` }, ctx);
  });
}

/** POST /api/exports (IF-35a). */
export async function createExport(ctx: ActorContext, rawBody: unknown): Promise<CreateExportResponseDto> {
  const { accountId, memberId } = requireMember(ctx);
  const input = parseCreateExportInput(rawBody);
  const id = newId<'export'>();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + exportConfig().expiresAfterDays * 24 * 60 * 60 * 1000);

  return withSpan(
    'm35.createExport',
    async () => {
      await insertExport(ctx, accountId, { id, source: input.source, format: input.format, createdAt: now, expiresAt });

      const payload: BuildJobPayload = {
        v: 1,
        exportId: id,
        accountId,
        memberId,
        region: ctx.region,
        locale: ctx.locale,
        mfaVerified: ctx.mfaVerified,
        entitlements: ctx.entitlements,
        source: input.source,
        format: input.format,
      };
      if (ctx.workspaceId) payload.workspaceId = ctx.workspaceId;
      if (ctx.role) payload.role = ctx.role;
      await enqueueBuildJob(ctx, payload);

      return { exportId: id };
    },
    { format: input.format },
  );
}

/** GET /api/exports/:id (IF-35a). */
export async function getExport(ctx: ActorContext, rawId: unknown): Promise<GetExportResponseDto> {
  requireMember(ctx);
  const id = parseExportIdParam(rawId);
  const row = await findExport(ctx, id);
  if (!row) throw new AppError('NOT_FOUND', 'Export not found');

  const out: GetExportResponseDto = { state: row.state, expiresAt: row.expiresAt.toISOString() };
  if (row.rowCount !== null) out.rows = row.rowCount;
  if (row.state === 'ready' && row.s3Key) out.downloadUrl = await presignExportDownload(row.s3Key);
  return out;
}
