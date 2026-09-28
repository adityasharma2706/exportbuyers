/**
 * M38 — server side (IF-38b). REQ-061.
 *
 *   requestDataExport(ctx)         POST /api/me/data-export        -> 202 {requestId}
 *   getDataExportStatus(ctx, id)   GET  /api/me/data-export/:id    -> 200 DataExportStatusDto
 *   requestAccountDeletion(ctx, b) POST /api/me/delete {confirm}   -> 202 {requestId}
 *   getAccountDeletionStatus(ctx,id) GET /api/me/delete/:id        -> 200 DeleteAccountStatusDto
 *   withdrawConsentAndPossiblyDelete(ctx, body) is NOT here: `POST /api/me/consent/withdraw
 *   {purpose}` (LLD IF-38b) simply forwards to M06's own `/api/consent/withdraw` — M06 already
 *   owns that route (routes.ts), including the `core_service` confirmation gate, and its own
 *   withdrawConsent() is what emits EV-11, which is what starts M38's erase flow (events.ts). This
 *   file re-exposes the identical path here only if a caller wants it under `/api/me/...`; see
 *   routes.ts for why it simply mounts M06's handler under both paths rather than duplicating it.
 *
 * Mirrors M35's service.ts: insert a request row, enqueue a job, let the UI poll GET for the
 * result (same "insert + enqueue, poll for completion" shape).
 */
import { AppError, systemDb, withSpan, type ActorContext } from '../m01_platform/index.js';
import { requireMember } from '../m05_identity/index.js';
import { enqueue, type Tx } from '../m02_queue/index.js';
import { ERASE_JOB_TYPE, ERASE_MAX_ATTEMPTS, EXPORT_JOB_TYPE, EXPORT_MAX_ATTEMPTS, RIGHTS_JOB_QUEUE, RIGHTS_RATE_CLASS } from './config.js';
import { presignRightsExportDownload } from './presign.js';
import { findInFlightRequest, findRequest, insertRequest } from './repo.js';
import type { EraseJobPayload } from './eraseJob.js';
import type { ExportJobPayload } from './exportJob.js';
import type {
  DataExportRequestDto,
  DataExportStatusDto,
  DeleteAccountRequestDto,
  DeleteAccountStatusDto,
  RightsRequest,
} from './types.js';

const DELETE_CONFIRM_PHRASE = 'DELETE';

async function enqueueExportJob(ctx: ActorContext, payload: ExportJobPayload): Promise<void> {
  const db = systemDb('m38: enqueue an export job');
  await db.transaction().execute(async (tx: Tx) => {
    await enqueue(
      tx,
      {
        type: EXPORT_JOB_TYPE,
        queue: RIGHTS_JOB_QUEUE,
        payload,
        idempotencyKey: `m38.export:${payload.requestId}`,
        maxAttempts: EXPORT_MAX_ATTEMPTS,
        rateClass: RIGHTS_RATE_CLASS,
      },
      ctx,
    );
  });
}

async function enqueueEraseJob(ctx: ActorContext, payload: EraseJobPayload): Promise<void> {
  const db = systemDb('m38: enqueue an erase job');
  await db.transaction().execute(async (tx: Tx) => {
    await enqueue(
      tx,
      {
        type: ERASE_JOB_TYPE,
        queue: RIGHTS_JOB_QUEUE,
        payload,
        idempotencyKey: `m38.erase:${payload.requestId}`,
        maxAttempts: ERASE_MAX_ATTEMPTS,
        rateClass: RIGHTS_RATE_CLASS,
      },
      ctx,
    );
  });
}

/** POST /api/me/data-export (IF-38b). At most one export request in flight per account at a
 * time; a repeat call while one is still queued/running just hands back that same request. */
export async function requestDataExport(ctx: ActorContext): Promise<DataExportRequestDto> {
  const { accountId } = requireMember(ctx);
  return withSpan('m38.requestDataExport', async () => {
    const existing = await findInFlightRequest(accountId, 'export');
    if (existing) return { requestId: existing.id };

    const request = await insertRequest(ctx, 'export', new Date());
    await enqueueExportJob(ctx, { v: 1, requestId: request.id, accountId });
    return { requestId: request.id };
  });
}

function toExportStatusDto(row: RightsRequest, downloadUrl?: string): DataExportStatusDto {
  const dto: DataExportStatusDto = {
    requestId: row.id,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
  if (downloadUrl) dto.downloadUrl = downloadUrl;
  return dto;
}

/** GET /api/me/data-export/:id (IF-38b). */
export async function getDataExportStatus(ctx: ActorContext, rawId: unknown): Promise<DataExportStatusDto> {
  requireMember(ctx);
  const id = requireIdParam(rawId);
  const row = await findRequest(ctx, id);
  if (!row || row.kind !== 'export') throw new AppError('NOT_FOUND', 'Export request not found');
  if (row.state === 'done' && row.zipS3Key) {
    return toExportStatusDto(row, await presignRightsExportDownload(row.zipS3Key));
  }
  return toExportStatusDto(row);
}

/** POST /api/me/delete (IF-38b): `{confirm: 'DELETE'}` is mandatory — this is irreversible. */
export async function requestAccountDeletion(ctx: ActorContext, rawBody: unknown): Promise<DeleteAccountRequestDto> {
  const { accountId } = requireMember(ctx);
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};
  if (body.confirm !== DELETE_CONFIRM_PHRASE) {
    throw new AppError('VALIDATION', `Deleting your account is irreversible; send {confirm: "${DELETE_CONFIRM_PHRASE}"} to continue`, {
      field: 'confirm',
      confirmRequired: true,
    });
  }
  return withSpan('m38.requestAccountDeletion', async () => {
    const existing = await findInFlightRequest(accountId, 'erase');
    if (existing) return { requestId: existing.id };

    const request = await insertRequest(ctx, 'erase', new Date());
    await enqueueEraseJob(ctx, { v: 1, requestId: request.id, accountId });
    return { requestId: request.id };
  });
}

function toDeleteStatusDto(row: RightsRequest): DeleteAccountStatusDto {
  return {
    requestId: row.id,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    retained: row.retained ?? [],
  };
}

/** GET /api/me/delete/:id (IF-38b). */
export async function getAccountDeletionStatus(ctx: ActorContext, rawId: unknown): Promise<DeleteAccountStatusDto> {
  requireMember(ctx);
  const id = requireIdParam(rawId);
  const row = await findRequest(ctx, id);
  if (!row || row.kind !== 'erase') throw new AppError('NOT_FOUND', 'Deletion request not found');
  return toDeleteStatusDto(row);
}

function requireIdParam(rawId: unknown): string {
  if (typeof rawId !== 'string' || rawId.trim().length === 0) throw new AppError('VALIDATION', 'A request id is required', { field: 'id' });
  return rawId;
}
