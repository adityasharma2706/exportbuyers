/**
 * M35 — the `m35.build` background job (LLD Job m35.build). Rebuilds an ActorContext from the
 * payload (a worker has no HTTP request to resolve a session from — mirrors M29's own
 * `ctxFromPayload` for `m29.reveal_bulk`), then runs the whole build: resolve rows through M10,
 * apply the account's monthly row cap, attach only already-revealed contacts, watermark, upload.
 */
import { z } from 'zod';
import {
  AppError,
  log,
  newId,
  objectStore,
  withSpan,
  type ActorContext,
  type Entitlements,
  type Id,
} from '../m01_platform/index.js';
import { registerHandler, registerRateClass, type PayloadSchema } from '../m02_queue/index.js';
import { byIds, permits, searchQuerySchema, search as m10Search, type ProfileDoc, type SearchDoc } from '../m10_policy/index.js';
import { passesDiscoveryReleaseGate } from '../m26_buyer_search/index.js';
import { revealedContacts, type RevealedContact } from '../m29_reveal/index.js';
import { isShortlistStatus, listWorkspaceShortlist } from '../m33_pipeline/index.js';
import { BUILD_JOB_TYPE, BUILD_RATE_CLASS, CANARY_EMAIL_DOMAIN, exportConfig } from './config.js';
import { markExportReady, markExportState, monthlyReadyRowUsage } from './repo.js';
import { rowFromProfileDoc, rowFromSearchDoc } from './rows.js';
import { isShortlistSource, EMPTY_CONTACT_COLUMNS, type BuildJobPayload, type ExportContactColumns, type ExportRowData, type ExportSource } from './types.js';
import { buildCsv, buildXlsx } from './workbook.js';

// ---- job payload schema -----------------------------------------------------------------------

const entitlementsSchema = z
  .object({
    plan: z.enum(['anonymous', 'free', 'starter', 'growth']),
    searchResultCap: z.number(),
    exportRowsPerMonth: z.number(),
    bulkRevealMax: z.number(),
    checksPerMonth: z.number(),
    revealsIncludedPerMonth: z.number(),
  })
  .strict();

const shortlistSourceJobSchema = z
  .object({
    shortlist: z
      .object({ workspaceId: z.string().uuid(), status: z.string().refine(isShortlistStatus).optional() })
      .strict(),
  })
  .strict();
const searchSourceJobSchema = z.object({ search: searchQuerySchema }).strict();

const buildJobSchema = z
  .object({
    v: z.literal(1),
    exportId: z.string().uuid(),
    accountId: z.string().uuid(),
    memberId: z.string().uuid(),
    workspaceId: z.string().uuid().optional(),
    role: z.string().optional(),
    region: z.string().min(2).max(2),
    locale: z.enum(['en', 'hi']),
    mfaVerified: z.boolean(),
    entitlements: entitlementsSchema,
    source: z.union([shortlistSourceJobSchema, searchSourceJobSchema]),
    format: z.enum(['xlsx', 'csv']),
  })
  .strict();

const schema: PayloadSchema<BuildJobPayload> = {
  safeParse(input: unknown) {
    const r = buildJobSchema.safeParse(input);
    return r.success ? { success: true, data: r.data as BuildJobPayload } : { success: false, error: { message: r.error.message } };
  },
};

function ctxFromPayload(p: BuildJobPayload): ActorContext {
  const ctx: ActorContext = {
    kind: 'user',
    accountId: p.accountId as Id<'account'>,
    memberId: p.memberId as Id<'member'>,
    entitlements: p.entitlements as Entitlements,
    locale: p.locale,
    region: p.region,
    mfaVerified: p.mfaVerified,
    correlationId: newId<'correlation'>(),
  };
  if (p.workspaceId) ctx.workspaceId = p.workspaceId as Id<'workspace'>;
  if (p.role) ctx.role = p.role as ActorContext['role'];
  return ctx;
}

// ---- row resolution (LLD Job step 1-2) ---------------------------------------------------------

async function resolveRows(ctx: ActorContext, source: ExportSource): Promise<ExportRowData[]> {
  if (isShortlistSource(source)) {
    const list = await listWorkspaceShortlist(ctx, source.shortlist.workspaceId, source.shortlist.status ?? undefined);
    const companyIds = [...new Set(list.entries.map((e) => e.companyId))];
    if (companyIds.length === 0) return [];
    const entries = await byIds(ctx, 'export', companyIds);
    const out: ExportRowData[] = [];
    for (const id of companyIds) {
      const entry = entries.get(id as Id<'company'>);
      const doc: ProfileDoc | null | undefined = entry?.doc;
      if (!entry || !doc || !permits(entry.decision, 'export')) continue;
      out.push(rowFromProfileDoc(doc));
    }
    return out;
  }
  const result = await m10Search(ctx, 'export', source.search);
  const out: ExportRowData[] = [];
  for (const row of result.rows) {
    if (!permits(row.decision, 'export')) continue;
    const doc: SearchDoc = row.doc;
    if (!passesDiscoveryReleaseGate(doc)) continue;
    out.push(rowFromSearchDoc(doc));
  }
  return out;
}

// ---- contacts (LLD Job step 2: "Contact columns are filled only from revealedContacts(ctx)") ---

function toContactColumns(rows: readonly RevealedContact[]): Map<string, ExportContactColumns> {
  const out = new Map<string, ExportContactColumns>();
  for (const r of rows) {
    const cols = out.get(r.companyId) ?? { ...EMPTY_CONTACT_COLUMNS };
    const value = r.value;
    switch (r.kind) {
      case 'role_email':
        cols.email = cols.email ? `${cols.email}; ${value}` : value;
        break;
      case 'phone':
        cols.phone = cols.phone ? `${cols.phone}; ${value}` : value;
        break;
      case 'website':
        cols.website = cols.website ? `${cols.website}; ${value}` : value;
        break;
      case 'whatsapp':
        cols.whatsapp = cols.whatsapp ? `${cols.whatsapp}; ${value}` : value;
        break;
      case 'form_url':
        cols.formUrl = cols.formUrl ? `${cols.formUrl}; ${value}` : value;
        break;
      case 'address':
        cols.address = cols.address ? `${cols.address}; ${value}` : value;
        break;
      default:
        break;
    }
    out.set(r.companyId, cols);
  }
  return out;
}

// ---- watermark / canary (LLD Job step 4) --------------------------------------------------------

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function buildCanaryRow(exportId: string): { canaryId: string; data: ExportRowData; contacts: ExportContactColumns } {
  const canaryId = newId<'company'>();
  return {
    canaryId,
    data: {
      companyId: canaryId,
      name: `Do not contact - export monitor ${canaryId.slice(0, 8)}`,
      country: 'XX',
      city: null,
      buyerType: null,
      trustLevel: 'unknown',
      hsHeadings: '',
      lastActivity: null,
      shipments12m: null,
      volumeKg12m: null,
    },
    contacts: { ...EMPTY_CONTACT_COLUMNS, email: `export-${exportId}@${CANARY_EMAIL_DOMAIN}` },
  };
}

function keyFor(accountId: string, exportId: string, format: 'xlsx' | 'csv'): string {
  return `${exportConfig().keyPrefix}/${accountId}/${exportId}.${format === 'xlsx' ? 'xlsx' : 'csv'}`;
}

// ---- the build ------------------------------------------------------------------------------

export async function buildExport(ctx: ActorContext, payload: BuildJobPayload): Promise<void> {
  const { exportId, accountId, format, source } = payload;
  await markExportState(ctx, exportId, 'running', new Date());

  await withSpan(
    'm35.build',
    async () => {
      const rows = await resolveRows(ctx, source);

      const usage = await monthlyReadyRowUsage(ctx, startOfMonthUtc(new Date()));
      const cap = Math.max(0, payload.entitlements.exportRowsPerMonth - usage);
      const truncated = rows.length > cap;
      const finalRows = rows.slice(0, cap);

      const companyIds = finalRows.map((r) => r.companyId);
      const revealed = companyIds.length > 0 ? await revealedContacts(ctx, companyIds) : [];
      const contactsByCompany = toContactColumns(revealed);

      const rowsWithContacts = finalRows.map((data) => ({
        data,
        contacts: contactsByCompany.get(data.companyId) ?? { ...EMPTY_CONTACT_COLUMNS },
      }));

      const canary = buildCanaryRow(exportId);
      const limitNote = truncated
        ? `Export limit reached: showing ${finalRows.length} of ${rows.length} matching rows this month. Upgrade your plan for a higher monthly export limit.`
        : null;

      const createdAt = new Date();
      const input = { accountId, createdAt, rows: rowsWithContacts, canaryRow: canary, limitNote };

      const key = keyFor(accountId, exportId, format);
      if (format === 'xlsx') {
        const buf = await buildXlsx(input);
        await objectStore().put(key, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      } else {
        const csv = buildCsv(input);
        await objectStore().put(key, csv, 'text/csv; charset=utf-8');
      }

      await markExportReady(
        ctx,
        exportId,
        { rowCount: finalRows.length, s3Key: key, canaryIds: [canary.canaryId], companyIds },
        new Date(),
      );
      log.info({ exportId, accountId, rows: finalRows.length, truncated }, 'm35: export built');
    },
    { exportId, accountId },
  ).catch(async (err: unknown) => {
    log.error({ err, exportId, accountId }, 'm35: export build failed');
    await markExportState(ctx, exportId, 'failed', new Date()).catch((e: unknown) =>
      log.error({ err: e, exportId }, 'm35: failed to record a failed export'),
    );
    throw err instanceof AppError ? err : new AppError('INTERNAL', 'Export build failed', undefined, { cause: err });
  });
}

let registered = false;

/** Registers M35's `m35.build` job handler. Call once at worker boot. */
export function registerExportBuildJob(): void {
  if (registered) return;
  registerRateClass(BUILD_RATE_CLASS, 4, 2);
  registerHandler(BUILD_JOB_TYPE, schema, async (payload) => {
    const ctx = ctxFromPayload(payload);
    await buildExport(ctx, payload);
  });
  registered = true;
}

/** For tests. */
export function resetExportBuildJobForTesting(): void {
  registered = false;
}
