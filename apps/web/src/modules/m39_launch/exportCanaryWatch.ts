/**
 * M39 — export canary monitoring (LLD M39 #3: "Export canaries are monitored by a web-search
 * alert job, which runs monthly."). REQ-004, REQ-051 (abuse limits).
 *
 * M35 already stamps one synthetic "do not contact" canary row into every ready export, with a
 * unique email `export-<exportId>@<CANARY_EMAIL_DOMAIN>` (m35_export/build.ts `buildCanaryRow` /
 * config.ts `CANARY_EMAIL_DOMAIN`). If a bulk-resold copy of our data ever surfaces publicly
 * (a scraped listing, a leaked spreadsheet), that address is exactly the kind of thing a web
 * search would index. This job reconstructs the canary addresses for exports built inside the
 * lookback window and searches the open web for each one; a hit means our data has leaked and
 * should be investigated.
 */
import { sql } from 'kysely';
import { AppError, getSecret, hasSecret, log, newId, systemDb } from '../m01_platform/index.js';
// CANARY_EMAIL_DOMAIN is not part of M35's public index.ts surface (deliberately internal to that
// module's build job); imported directly from its defining file rather than widening M35's public
// API on M39's behalf. See deviation note in the PIPELINE-PROGRESS block for this module.
import { CANARY_EMAIL_DOMAIN } from '../m35_export/config.js';
import { registerHandler, registerSchedule, type PayloadSchema } from '../m02_queue/index.js';
import { launchHardeningConfig } from './config.js';

export interface ActiveCanary {
  exportId: string;
  accountId: string;
  canaryEmail: string;
  createdAt: Date;
}

/** Ready exports created since `since`, one canary per export (LLD Job m35.build: one canary per
 * export; `canary_ids` always has exactly one entry when the export succeeded). */
export async function listActiveCanaries(since: Date, limit: number): Promise<ActiveCanary[]> {
  const rows = await sql<{ id: string; account_id: string; created_at: Date }>`
    select id, account_id, created_at
      from serving.export
     where state = 'ready' and created_at >= ${since} and array_length(canary_ids, 1) > 0
     order by created_at desc
     limit ${limit}
  `.execute(systemDb('m39: list active export canaries'));
  return rows.rows.map((r) => ({
    exportId: r.id,
    accountId: r.account_id,
    canaryEmail: `export-${r.id}@${CANARY_EMAIL_DOMAIN}`,
    createdAt: new Date(r.created_at),
  }));
}

// ---- web search vendor (injectable) ------------------------------------------------------------

export interface WebSearchHit {
  url: string;
  title: string;
  snippet: string;
}

/** Minimal search transport: one query in, matching indexed pages out. Injectable for tests. */
export type WebSearchTransport = (query: string) => Promise<WebSearchHit[]>;

export const SECRET_WEB_SEARCH_API_KEY = 'WEB_SEARCH_API_KEY';
const DEFAULT_WEB_SEARCH_URL = 'https://api.bing.microsoft.com/v7.0/search';

interface BingWebPage {
  url?: unknown;
  name?: unknown;
  snippet?: unknown;
}
interface BingSearchResponse {
  webPages?: { value?: BingWebPage[] };
}

/** Generic web-search-API transport (Bing Web Search v7 shape by default; swap the base URL for
 * another vendor with the same query-param/JSON-body contract). */
export const defaultWebSearchTransport: WebSearchTransport = async (query) => {
  if (!hasSecret(SECRET_WEB_SEARCH_API_KEY)) {
    throw new AppError('UPSTREAM_UNAVAILABLE', 'No web-search vendor is configured', { vendor: 'web_search' });
  }
  const url = `${process.env.M39_WEB_SEARCH_URL ?? DEFAULT_WEB_SEARCH_URL}?q=${encodeURIComponent(`"${query}"`)}&count=10`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': getSecret(SECRET_WEB_SEARCH_API_KEY) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new AppError('UPSTREAM_UNAVAILABLE', 'Web search vendor unreachable', { vendor: 'web_search' }, { cause: e });
  }
  if (!res.ok) throw new AppError('UPSTREAM_UNAVAILABLE', `Web search vendor returned HTTP ${res.status}`, { vendor: 'web_search' });
  const body = (await res.json().catch(() => ({}))) as BingSearchResponse;
  const pages = body.webPages?.value ?? [];
  return pages
    .filter((p): p is Required<BingWebPage> => typeof p.url === 'string' && typeof p.name === 'string')
    .map((p) => ({ url: String(p.url), title: String(p.name), snippet: typeof p.snippet === 'string' ? p.snippet : '' }));
};

let transport: WebSearchTransport | undefined;

export function setWebSearchTransport(t: WebSearchTransport | undefined): void {
  transport = t;
}

function webSearch(): WebSearchTransport {
  return transport ?? defaultWebSearchTransport;
}

// ---- the run ------------------------------------------------------------------------------------

export interface CanaryHit {
  exportId: string;
  accountId: string;
  canaryEmail: string;
  urls: string[];
}

export interface CanaryWatchResult {
  checked: number;
  hits: CanaryHit[];
}

/** Records a hit for audit (analytics.export_canary_hit — see the M39 migration). Also raises a
 * structured on-call alert (log.error routes to alerting, the same pattern M01's budget.ts uses). */
async function recordHit(hit: CanaryHit, now: Date): Promise<void> {
  log.error(
    { alert: 'export_canary_leaked', exportId: hit.exportId, accountId: hit.accountId, urls: hit.urls },
    `export canary leaked: ${hit.canaryEmail} found on the open web (${hit.urls.length} result(s))`,
  );
  await sql`
    insert into analytics.export_canary_hit (id, export_id, account_id, canary_email, urls, found_at)
    values (${newId<'export_canary_hit'>()}, ${hit.exportId}, ${hit.accountId}, ${hit.canaryEmail}, ${JSON.stringify(hit.urls)}::jsonb, ${now})
  `.execute(systemDb('m39: record export canary hit'));
}

/** The monthly job body. Best-effort per canary: one vendor failure does not stop the run. */
export async function runExportCanaryWatch(now: Date = new Date()): Promise<CanaryWatchResult> {
  const cfg = launchHardeningConfig().exportCanaryWatch;
  const since = new Date(now.getTime() - cfg.lookbackDays * 24 * 3600 * 1000);
  const canaries = await listActiveCanaries(since, cfg.maxCanariesPerRun);
  const search = webSearch();
  const hits: CanaryHit[] = [];

  for (const canary of canaries) {
    try {
      const results = await search(canary.canaryEmail);
      if (results.length > 0) {
        const hit: CanaryHit = { exportId: canary.exportId, accountId: canary.accountId, canaryEmail: canary.canaryEmail, urls: results.map((r) => r.url) };
        hits.push(hit);
        await recordHit(hit, now);
      }
    } catch (err) {
      log.warn({ err, exportId: canary.exportId }, 'm39: export canary web search failed; skipping this canary this run');
    }
  }
  return { checked: canaries.length, hits };
}

// ---- job registration ---------------------------------------------------------------------------

export const CANARY_WATCH_JOB = 'm39.export_canary_watch';

const v1Schema: PayloadSchema<{ v: 1 }> = {
  safeParse(input: unknown) {
    if (input !== null && typeof input === 'object' && (input as { v?: unknown }).v === 1) {
      return { success: true, data: { v: 1 } };
    }
    return { success: false, error: { message: 'payload must be {v:1}' } };
  },
};

let registered = false;

/** Registers the monthly canary-watch job. Idempotent; call once at worker boot. */
export function registerExportCanaryWatchJob(): void {
  if (registered) return;
  registerHandler(CANARY_WATCH_JOB, v1Schema, async () => {
    const r = await runExportCanaryWatch();
    log.info(r, 'm39: export canary watch complete');
  });
  // First of the month, 03:00 UTC [tunable].
  registerSchedule('m39-export-canary-watch', '0 3 1 * *', CANARY_WATCH_JOB, { v: 1 }, 'serving');
  registered = true;
}

/** For tests. */
export function resetExportCanaryWatchJobForTesting(): void {
  registered = false;
}
