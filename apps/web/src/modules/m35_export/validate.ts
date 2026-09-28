/**
 * M35 — request validation (LLD M35 API: `POST /api/exports {source, format}`).
 */
import { z } from 'zod';
import { AppError, isUuid } from '../m01_platform/index.js';
import { searchQuerySchema } from '../m10_policy/index.js';
import { isShortlistStatus } from '../m33_pipeline/index.js';
import { EXPORT_FORMATS, type CreateExportInput, type ExportFormat, type ExportSource } from './types.js';

function objectBody(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new AppError('VALIDATION', 'Request body must be a JSON object');
  return v as Record<string, unknown>;
}

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && (EXPORT_FORMATS as readonly string[]).includes(v);
}

const shortlistSourceSchema = z
  .object({
    shortlist: z
      .object({
        workspaceId: z.string().refine(isUuid, 'workspaceId must be a uuid'),
        status: z.string().refine(isShortlistStatus, 'invalid status').optional(),
      })
      .strict(),
  })
  .strict();

const searchSourceSchema = z.object({ search: searchQuerySchema }).strict();

const sourceSchema = z.union([shortlistSourceSchema, searchSourceSchema]);

/** POST /api/exports body: `{source, format}` (LLD M35 IF-35a). */
export function parseCreateExportInput(raw: unknown): CreateExportInput {
  const b = objectBody(raw);
  if (!isExportFormat(b.format)) {
    throw new AppError('VALIDATION', `format must be one of ${EXPORT_FORMATS.join(', ')}`, { field: 'format' });
  }
  const parsed = sourceSchema.safeParse(b.source);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Invalid export source', { field: 'source', issues: parsed.error.issues });
  }
  return { source: parsed.data as ExportSource, format: b.format };
}

export function parseExportIdParam(v: unknown): string {
  if (typeof v !== 'string' || !isUuid(v)) throw new AppError('NOT_FOUND', 'Export not found');
  return v.toLowerCase();
}
