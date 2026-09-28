/**
 * M38 — the built-in IF-38a contributors for M38's own declared dependencies (docs/implementer.md:
 * M02, M06, M07, M28, M33, M34, M36). M05 is included too, even though it is only a transitive
 * dependency (via M06/M07): its dataRights.ts (exportIdentity/eraseIdentity) already documents
 * itself as "IF-38a: export returns the member's identifiers. Erase deletes sessions and nulls
 * the phone and email" — it is a contributor by its own module's design, just not one M38 lists as
 * a direct dependency (see registry.ts's deviation note for the analogous gap on M29/M30/M32/M35).
 *
 * M33's (serving.shortlist_entry/status_history/note) and M34's (serving.draft) tables have no
 * whole-account export/erase function in their own public API (neither module exposes one — see
 * their index.ts), so this file queries/deletes them directly through M01's shared, registered
 * TenantTable mechanism (`scoped(ctx)`), the same way M34's own repo.ts already reads M33's
 * serving.shortlist_entry directly (see that file's doc comment) rather than through M33's index.
 * Importing from m33_pipeline/index.js and m34_draft/index.js below (for their exported types/
 * events) guarantees both modules' `registerTenantTable(...)` calls have already run via ordinary
 * ES module evaluation, so those tables' tenant scope is known before any query here runs.
 */
import { scoped, systemDb, type Db } from '../m01_platform/index.js';
import { sql } from 'kysely';
import {
  cancelSubscription,
  entitlementsForAccount,
  getMyBillingDetails,
  listInvoices,
} from '../m36_billing/index.js';
import { allowanceRemaining, balance, usageHistory } from '../m28_credits/index.js';
import { eraseConsent, exportConsent } from '../m06_consent/index.js';
import { eraseIdentity, exportIdentity } from '../m05_identity/index.js';
import { eraseTenancy, exportTenancy } from '../m07_tenancy/index.js';
// Side-effect only imports: guarantee M33's and M34's tenant tables are registered before the
// raw scoped() queries below run (see the module doc comment).
import type {} from '../m33_pipeline/index.js';
import type {} from '../m34_draft/index.js';
import { CONTRIBUTOR_ORDER, registerContributor } from './registry.js';
import { systemCtxFor } from './systemCtx.js';
import type { ContributorEraseResult, ContributorExportResult } from './types.js';

// ---- M34: drafts (order 10) -----------------------------------------------------------------

async function exportDrafts(accountId: string): Promise<ContributorExportResult> {
  const rows = (await systemDb('m38: export drafts')
    .selectFrom('serving.draft')
    .selectAll()
    .where('account_id', '=', accountId)
    .orderBy('created_at', 'asc')
    .execute()) as Array<Record<string, unknown>>;
  return {
    files: [
      {
        name: 'm34_drafts.json',
        json: rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspace_id,
          entryId: r.entry_id,
          kind: r.kind,
          language: r.language,
          tone: r.tone,
          bodyGenerated: r.body_generated,
          footer: r.footer,
          bodyEdited: r.body_edited,
          leftVia: r.left_via,
          leftAt: r.left_at,
          createdAt: r.created_at,
        })),
      },
    ],
  };
}

async function eraseDrafts(accountId: string): Promise<ContributorEraseResult> {
  const db = scoped(systemCtxFor(accountId));
  await db.deleteFrom('serving.draft').execute();
  return {};
}

// ---- M33: shortlist entries, statuses and notes (order 20) --------------------------------

async function exportPipeline(accountId: string): Promise<ContributorExportResult> {
  const db = systemDb('m38: export pipeline');
  const [entries, notes, history] = await Promise.all([
    db.selectFrom('serving.shortlist_entry').selectAll().where('account_id', '=', accountId).orderBy('created_at', 'asc').execute(),
    db.selectFrom('serving.note').selectAll().where('account_id', '=', accountId).orderBy('created_at', 'asc').execute(),
    db.selectFrom('serving.status_history').selectAll().where('account_id', '=', accountId).orderBy('at', 'asc').execute(),
  ]) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>];
  return {
    files: [
      {
        name: 'm33_pipeline.json',
        json: {
          shortlistEntries: entries.map((r) => ({
            id: r.id,
            workspaceId: r.workspace_id,
            companyId: r.company_id,
            status: r.status,
            nextActionAt: r.next_action_at,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          })),
          notes: notes.map((r) => ({ id: r.id, entryId: r.entry_id, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at })),
          statusHistory: history.map((r) => ({ id: r.id, entryId: r.entry_id, from: r.from_status, to: r.to_status, source: r.source, at: r.at })),
        },
      },
    ],
  };
}

async function erasePipeline(accountId: string): Promise<ContributorEraseResult> {
  const db = scoped(systemCtxFor(accountId));
  // Children first (FK: note.entry_id / status_history.entry_id -> shortlist_entry.id).
  await db.deleteFrom('serving.note').execute();
  await db.deleteFrom('serving.status_history').execute();
  await db.deleteFrom('serving.shortlist_entry').execute();
  return {};
}

// ---- M28: credits ledger (order 75) --------------------------------------------------------
// LLD Rules: "M28 keeps the ledger rows, and the account_id stays because it is a uuid with no
// personal data" — nothing is deleted; export includes the account's own transactional history.

async function exportCredits(accountId: string): Promise<ContributorExportResult> {
  const ctx = systemCtxFor(accountId);
  const [bal, allowances] = await Promise.all([balance(ctx), allowanceRemaining(ctx)]);
  const txns: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 500; page++) {
    const result = await usageHistory(ctx, cursor);
    txns.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return { files: [{ name: 'm28_credits.json', json: { balance: bal, allowanceRemaining: allowances, transactions: txns } }] };
}

async function eraseCredits(_accountId: string): Promise<ContributorEraseResult> {
  return { retained: ['ledger entries (ledger.entry — the account_id is an opaque uuid with no personal data; kept for financial audit)'] };
}

// ---- M36: billing (order 80) ---------------------------------------------------------------
// LLD Rules: "M36 keeps invoices for 8 years. Their personal fields (address, legal name) are
// kept as the law requires." serving.billing_details (the live legal-name/GSTIN/address used to
// generate *future* invoices) is minimised by deleting it; already-issued invoices (and their
// PDFs, which embed the legal name/address as of issue date) are untouched — that is the
// statutory retention this rule protects.

async function exportBilling(accountId: string): Promise<ContributorExportResult> {
  const ctx = systemCtxFor(accountId);
  const [invoices, details, entitlements] = await Promise.all([
    listInvoices(ctx),
    getMyBillingDetails(ctx),
    entitlementsForAccount(accountId).catch(() => null),
  ]);
  return {
    files: [
      {
        name: 'm36_billing.json',
        json: {
          invoices: invoices.map((i) => ({
            id: i.id,
            number: i.number,
            gstin: i.gstin,
            placeOfSupply: i.placeOfSupply,
            taxablePaise: i.taxablePaise,
            cgstPaise: i.cgstPaise,
            sgstPaise: i.sgstPaise,
            igstPaise: i.igstPaise,
            issuedAt: i.issuedAt,
          })),
          billingDetails: details,
          entitlements,
        },
      },
    ],
  };
}

async function eraseBilling(accountId: string): Promise<ContributorEraseResult> {
  // Cancellation itself already happened in the erase job's own step 1 (LLD Rules step 1: "cancel
  // the subscription (M36)"); this only minimises the live billing_details row. NOT_FOUND (no
  // details on file) is expected and not an error.
  await systemDb('m38: minimise billing details').deleteFrom('serving.billing_details').where('account_id', '=', accountId).execute();
  return { retained: ['issued invoices, GST invoice PDFs and payment records (8-year statutory retention; legal name/address as of issue date are kept as the law requires)'] };
}

// ---- M05: identity (order 90) ---------------------------------------------------------------

async function exportIdentityContributor(accountId: string): Promise<ContributorExportResult> {
  return { files: [{ name: 'm05_identity.json', json: await exportIdentity(accountId) }] };
}

async function eraseIdentityContributor(accountId: string): Promise<ContributorEraseResult> {
  await eraseIdentity(accountId);
  return {};
}

// ---- M07: tenancy (order 95) — must run after M33/M34 erase (FK: shortlist_entry/draft/note/
// status_history.workspace_id -> serving.workspace.id) ---------------------------------------

async function exportTenancyContributor(accountId: string): Promise<ContributorExportResult> {
  return { files: [{ name: 'm07_tenancy.json', json: await exportTenancy(accountId) }] };
}

async function eraseTenancyContributor(accountId: string): Promise<ContributorEraseResult> {
  await eraseTenancy(accountId);
  return {};
}

// ---- M06: consent (order 100, last per LLD) --------------------------------------------------

async function exportConsentContributor(accountId: string): Promise<ContributorExportResult> {
  return { files: [{ name: 'm06_consent.json', json: await exportConsent(accountId) }] };
}

async function eraseConsentContributor(accountId: string): Promise<ContributorEraseResult> {
  await eraseConsent(accountId);
  return { retained: ['consent and withdrawal history (serving.consent_event — proof of consent; only the IP address is minimised)'] };
}

// ---- registration -----------------------------------------------------------------------------

let registered = false;

/** Registers M38's built-in contributors. Call once at boot, after M05, M06, M07, M28, M33, M34
 * and M36 have run their own module-level side effects (tenant table registration etc.) — i.e.
 * after importing this module's own index.ts, which imports all of the above. */
export function registerBuiltinDataRightsContributors(): void {
  if (registered) return;
  registerContributor({ module: 'M34', export: exportDrafts, erase: eraseDrafts, order: CONTRIBUTOR_ORDER.M34_DRAFTS });
  registerContributor({ module: 'M33', export: exportPipeline, erase: erasePipeline, order: CONTRIBUTOR_ORDER.M33_PIPELINE });
  registerContributor({ module: 'M28', export: exportCredits, erase: eraseCredits, order: CONTRIBUTOR_ORDER.M28_CREDITS });
  registerContributor({ module: 'M36', export: exportBilling, erase: eraseBilling, order: CONTRIBUTOR_ORDER.M36_BILLING });
  registerContributor({ module: 'M05', export: exportIdentityContributor, erase: eraseIdentityContributor, order: CONTRIBUTOR_ORDER.M05_IDENTITY });
  registerContributor({ module: 'M07', export: exportTenancyContributor, erase: eraseTenancyContributor, order: CONTRIBUTOR_ORDER.M07_TENANCY });
  registerContributor({ module: 'M06', export: exportConsentContributor, erase: eraseConsentContributor, order: CONTRIBUTOR_ORDER.M06_CONSENT });
  registered = true;
}

/** For tests. */
export function resetBuiltinDataRightsContributorsForTesting(): void {
  registered = false;
}

/** LLD Rules step 1 helper: cancels the account's active subscription before contributors run.
 * NOT_FOUND (no active subscription, e.g. Free plan) is expected and swallowed; any other error
 * propagates so the erase job retries. */
export async function cancelSubscriptionIfAny(accountId: string): Promise<void> {
  try {
    await cancelSubscription(systemCtxFor(accountId), { atPeriodEnd: false });
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === 'NOT_FOUND') return;
    throw e;
  }
}

// db import kept for the raw sql tag used indirectly by systemDb query builders above (Kysely's
// `sql` is not used directly in this file, but selectFrom/deleteFrom's typings resolve through
// the Db type re-exported by m01_platform; importing `sql`/`Db` keeps the module self-contained
// for future raw-SQL contributors added here).
export type { Db };
export { sql };
