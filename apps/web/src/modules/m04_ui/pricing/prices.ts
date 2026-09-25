/**
 * M04 — client for the price catalogue served by M28 at GET /api/prices (IF-28c), plus the pure
 * cost computation that CostBadge displays (REQ-054).
 *
 * Nothing here hard-codes a price: every number comes from the catalogue. M28's `quote()` remains
 * authoritative for what is charged; this module mirrors its formula for display only.
 */

/** Credit-consuming actions in the M28 catalogue (`actions` in /config/prices.yaml). */
export const PRICE_ACTIONS = ['reveal', 'reveal_bulk_each', 'check_buyer', 'export_row'] as const;
export type PriceAction = (typeof PRICE_ACTIONS)[number];

export function isPriceAction(value: unknown): value is PriceAction {
  return typeof value === 'string' && (PRICE_ACTIONS as readonly string[]).includes(value);
}

export interface PriceCatalogueDto {
  version: string;
  effectiveFrom: string | null;
  /** Credits per unit of each action. Unknown future actions are kept too. */
  actions: Record<string, number>;
  /** ISO-3166 alpha-2 (upper-case) → multiplier. Missing countries are 1×. */
  countryMultipliers: Record<string, number>;
  /** Rupees per credit, when the catalogue publishes one; used to show "₹" next to credits. */
  inrPerCredit: number | null;
}

export class PriceUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string, cause?: unknown) {
    super(`Price unavailable: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'PriceUnavailableError';
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberMap(raw: unknown, field: string, opts: { positive: boolean; upperKeys: boolean }): Record<string, number> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new PriceUnavailableError(`malformed_${field}`);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (opts.positive && value === 0)) {
      throw new PriceUnavailableError(`malformed_${field}`);
    }
    out[opts.upperKeys ? key.toUpperCase() : key] = value;
  }
  return out;
}

/**
 * Validates the /api/prices payload. Accepts camelCase or the snake_case used in prices.yaml, so
 * the badge keeps working whichever casing M28's handler serialises.
 */
export function parseCatalogue(raw: unknown): PriceCatalogueDto {
  if (!isRecord(raw)) throw new PriceUnavailableError('malformed_body');
  const body = isRecord(raw.catalogue) ? raw.catalogue : raw;
  const version = body.version;
  if ((typeof version !== 'string' || version.length === 0) && typeof version !== 'number') {
    throw new PriceUnavailableError('missing_version');
  }
  const actions = numberMap(body.actions, 'actions', { positive: false, upperKeys: false });
  if (Object.keys(actions).length === 0) throw new PriceUnavailableError('missing_actions');
  const countryMultipliers = numberMap(body.countryMultipliers ?? body.country_multipliers, 'country_multipliers', {
    positive: true,
    upperKeys: true,
  });
  const effective = body.effectiveFrom ?? body.effective_from;
  const inrRaw = body.inrPerCredit ?? body.inr_per_credit;
  const inrPerCredit = typeof inrRaw === 'number' && Number.isFinite(inrRaw) && inrRaw > 0 ? inrRaw : null;
  return {
    version: String(version),
    effectiveFrom: typeof effective === 'string' ? effective : null,
    actions,
    countryMultipliers,
    inrPerCredit,
  };
}

export interface CostOptions {
  country?: string;
  quantity?: number;
}

export interface CostQuote {
  action: PriceAction;
  /** Total credits for `quantity` units. */
  credits: number;
  /** Credits per unit after the country multiplier. */
  unitCredits: number;
  quantity: number;
  /** 1 when no country multiplier applies. */
  multiplier: number;
  country: string | null;
  catalogueVersion: string;
  /** Rupee equivalent, or null when the catalogue does not publish a rupee rate. */
  inr: number | null;
  isFree: boolean;
}

/**
 * Mirrors M28 `quote(ctx, action, {country, quantity})`: unit = ceil(base × multiplier),
 * total = unit × quantity. Throws PriceUnavailableError when the action is not priced.
 */
export function computeCost(catalogue: PriceCatalogueDto, action: PriceAction, opts: CostOptions = {}): CostQuote {
  const quantity = opts.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) throw new PriceUnavailableError('invalid_quantity');
  const base = catalogue.actions[action];
  if (base === undefined) throw new PriceUnavailableError('unpriced_action');
  const country = opts.country ? opts.country.trim().toUpperCase() : null;
  const multiplier = country ? catalogue.countryMultipliers[country] ?? 1 : 1;
  const unitCredits = Math.ceil(base * multiplier - 1e-9);
  const credits = unitCredits * quantity;
  const inr = catalogue.inrPerCredit === null ? null : Math.round(credits * catalogue.inrPerCredit * 100) / 100;
  return {
    action,
    credits,
    unitCredits,
    quantity,
    multiplier,
    country,
    catalogueVersion: catalogue.version,
    inr,
    isFree: credits === 0,
  };
}

export type CostResolution =
  | { state: 'loading' }
  | { state: 'unavailable'; reason: string }
  | { state: 'ready'; quote: CostQuote };

/**
 * Decides what CostBadge shows. A failed fetch always means "price unavailable" (LLD M04 edge
 * case) — the badge never guesses a price.
 */
export function resolveCost(
  catalogue: PriceCatalogueDto | null,
  fetchError: string | null,
  action: PriceAction,
  opts: CostOptions = {},
): CostResolution {
  if (fetchError !== null) return { state: 'unavailable', reason: fetchError };
  if (catalogue === null) return { state: 'loading' };
  try {
    return { state: 'ready', quote: computeCost(catalogue, action, opts) };
  } catch (err) {
    return { state: 'unavailable', reason: err instanceof PriceUnavailableError ? err.reason : 'compute_failed' };
  }
}

// ---------------------------------------------------------------------------------------------
// Fetching, cached per catalogue version
// ---------------------------------------------------------------------------------------------

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; credentials?: 'same-origin' },
) => Promise<FetchResponseLike>;

export interface PriceClientOptions {
  endpoint?: string;
  /** How long a fetched catalogue is used without revalidating. */
  ttlMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export interface PriceClient {
  /** Returns the current catalogue, revalidating when the TTL has passed. Rejects with PriceUnavailableError. */
  getCatalogue(): Promise<PriceCatalogueDto>;
  /** The cached catalogue if it is still within its TTL, without any network call. */
  peek(): PriceCatalogueDto | null;
  /** Seeds the cache with a catalogue the server already rendered with. */
  prime(catalogue: PriceCatalogueDto): void;
  /** Forces the next getCatalogue() to revalidate. */
  invalidate(): void;
}

const MAX_CACHED_VERSIONS = 3;

export function createPriceClient(options: PriceClientOptions = {}): PriceClient {
  const endpoint = options.endpoint ?? '/api/prices';
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const now = options.now ?? (() => Date.now());

  // One entry per catalogue version; the same object is returned for the same version so React
  // memoisation downstream stays stable across revalidations.
  const byVersion = new Map<string, PriceCatalogueDto>();
  let currentVersion: string | null = null;
  let validatedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<PriceCatalogueDto> | null = null;

  const current = (): PriceCatalogueDto | null => (currentVersion === null ? null : byVersion.get(currentVersion) ?? null);
  const fresh = (): boolean => now() - validatedAt < ttlMs;

  function remember(catalogue: PriceCatalogueDto): PriceCatalogueDto {
    const existing = byVersion.get(catalogue.version);
    const value = existing ?? catalogue;
    byVersion.delete(catalogue.version);
    byVersion.set(catalogue.version, value);
    while (byVersion.size > MAX_CACHED_VERSIONS) {
      const oldest = byVersion.keys().next().value;
      if (oldest === undefined) break;
      byVersion.delete(oldest);
    }
    currentVersion = catalogue.version;
    validatedAt = now();
    return value;
  }

  async function fetchCatalogue(): Promise<PriceCatalogueDto> {
    const fetchImpl: FetchLike | undefined =
      options.fetchImpl ?? (typeof fetch === 'function' ? (fetch as unknown as FetchLike) : undefined);
    if (!fetchImpl) throw new PriceUnavailableError('no_fetch');
    const controller = new AbortController();
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      const cached = current();
      if (cached) headers['if-none-match'] = `"${cached.version}"`;
      let res: FetchResponseLike;
      try {
        res = await fetchImpl(endpoint, { headers, signal: controller.signal, credentials: 'same-origin' });
      } catch (err) {
        throw new PriceUnavailableError(controller.signal.aborted ? 'timeout' : 'network', err);
      }
      if (res.status === 304 && cached) {
        validatedAt = now();
        return cached;
      }
      if (!res.ok) throw new PriceUnavailableError(`http_${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        throw new PriceUnavailableError('malformed_body', err);
      }
      return remember(parseCatalogue(body));
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getCatalogue(): Promise<PriceCatalogueDto> {
      const cached = current();
      if (cached && fresh()) return Promise.resolve(cached);
      if (!inflight) {
        inflight = fetchCatalogue().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    peek(): PriceCatalogueDto | null {
      const cached = current();
      return cached && fresh() ? cached : null;
    },
    prime(catalogue: PriceCatalogueDto): void {
      remember(catalogue);
    },
    invalidate(): void {
      validatedAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/** Shared browser-side client: every CostBadge on a page shares one request and one cache. */
export const defaultPriceClient: PriceClient = createPriceClient();
