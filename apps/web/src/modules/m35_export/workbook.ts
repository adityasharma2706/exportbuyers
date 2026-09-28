/**
 * M35 — building the actual export file (LLD Job m35.build step 4 "Watermark"):
 *   - a header row: "Exported by <account id short> on <date>"
 *   - (xlsx only) a hidden sheet carrying the full account id
 *   - one canary row per export: a synthetic company tied to the account, whose contact address
 *     is unique to this export so a leaked copy can be traced back to it
 *   - (when truncated) a trailing "limit reached" note row
 *
 * [deviation: CSV has no concept of a second, hidden sheet. The account-id watermark that xlsx
 * puts on a hidden sheet is instead folded into the CSV's own leading comment row, which already
 * carries the short account id; the full id is appended there too so the same information is
 * present in both formats.]
 */
import ExcelJS from 'exceljs';
import { META_SHEET_NAME } from './config.js';
import type { ExportContactColumns, ExportRowData } from './types.js';

export const COLUMN_HEADERS: readonly string[] = [
  'Company ID',
  'Company Name',
  'Country',
  'City',
  'Buyer Type',
  'Trust Level',
  'HS Headings',
  'Last Activity',
  'Shipments (12m)',
  'Volume kg (12m)',
  'Email',
  'Phone',
  'Website',
  'WhatsApp',
  'Form URL',
  'Address',
];

export interface BuiltWorkbookInput {
  accountId: string;
  createdAt: Date;
  rows: ReadonlyArray<{ data: ExportRowData; contacts: ExportContactColumns }>;
  canaryRow: { data: ExportRowData; contacts: ExportContactColumns };
  limitNote: string | null;
}

function watermarkText(accountId: string, createdAt: Date): string {
  return `Exported by ${accountId.slice(0, 8)} on ${createdAt.toISOString().slice(0, 10)}`;
}

function rowToArray(data: ExportRowData, contacts: ExportContactColumns): Array<string | number | null> {
  return [
    data.companyId,
    data.name,
    data.country,
    data.city,
    data.buyerType,
    data.trustLevel,
    data.hsHeadings,
    data.lastActivity,
    data.shipments12m,
    data.volumeKg12m,
    contacts.email,
    contacts.phone,
    contacts.website,
    contacts.whatsapp,
    contacts.formUrl,
    contacts.address,
  ];
}

/** Builds the .xlsx workbook (LLD format 'xlsx'), returned as a Buffer ready for object storage. */
export async function buildXlsx(input: BuiltWorkbookInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ExportBuyers';
  wb.created = input.createdAt;

  const sheet = wb.addWorksheet('Export');
  sheet.addRow([watermarkText(input.accountId, input.createdAt)]);
  sheet.addRow([]);
  sheet.addRow([...COLUMN_HEADERS]);
  for (const r of input.rows) sheet.addRow(rowToArray(r.data, r.contacts));
  sheet.addRow(rowToArray(input.canaryRow.data, input.canaryRow.contacts));
  if (input.limitNote) sheet.addRow([input.limitNote]);
  sheet.getRow(3).font = { bold: true };

  // LLD Job step 4: "A hidden sheet with the account id."
  const meta = wb.addWorksheet(META_SHEET_NAME, { state: 'veryHidden' });
  meta.addRow(['account_id', input.accountId]);
  meta.addRow(['created_at', input.createdAt.toISOString()]);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

function csvField(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(fields: Array<string | number | null>): string {
  return fields.map(csvField).join(',');
}

/** Builds the .csv text (LLD format 'csv'). */
export function buildCsv(input: BuiltWorkbookInput): string {
  const lines: string[] = [];
  lines.push(csvLine([`${watermarkText(input.accountId, input.createdAt)} (account ${input.accountId})`]));
  lines.push(csvLine([...COLUMN_HEADERS]));
  for (const r of input.rows) lines.push(csvLine(rowToArray(r.data, r.contacts)));
  lines.push(csvLine(rowToArray(input.canaryRow.data, input.canaryRow.contacts)));
  if (input.limitNote) lines.push(csvLine([input.limitNote]));
  return `${lines.join('\r\n')}\r\n`;
}
