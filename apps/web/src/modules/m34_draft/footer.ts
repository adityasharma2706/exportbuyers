/**
 * M34 — IF-34b `buildFooter(profile, buyer, language)`, a pure function (LLD M34 API: "pure
 * function"). Assembled in code from the literal LLD wording, not from M37 content templates:
 * M37 (Content, Learn and promise pages), the module the LLD says the footer templates live in,
 * is built after this one in the module order and does not exist yet.
 *
 * [deviation: `language` is part of IF-34b's signature (presumably so the compliance footer can
 * be localised to the buyer's language, matching the drafted body), but with no M37 template
 * source to translate from, the footer text here is English only regardless of `language`. This
 * can be swapped for M37-sourced, per-locale templates once that module lands, without changing
 * the function's signature or call sites.]
 */

export interface FooterBusinessProfile {
  businessName: string;
  senderName: string;
  city: string | null;
  state: string | null;
  /** Importer-Exporter Code, uppercased 10 alphanumerics, or null when not set (LLD M07). */
  iec: string | null;
}

export interface FooterBuyer {
  /** ISO-3166-1 alpha-2. */
  country: string;
  /** `knowledge.source.source_type` values behind this buyer's company-level evidence
   * (LLD M10 DocFact.source_type / M08 source_type enum), deduplicated by the caller or not —
   * buildFooter deduplicates and orders them itself. */
  evidenceSourceTypes: string[];
}

/** LLD M34 Footer rule: "If the buyer's country is in the EU/EEA, the UK or CH". ISO-3166-1
 * alpha-2, upper case. EU-27 + the three other EEA states (IS, LI, NO) + the UK + Switzerland. */
export const EU_EEA_UK_CH_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV',
  'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', // EU-27
  'IS', 'LI', 'NO', // EEA (non-EU)
  'GB', // UK
  'CH', // Switzerland
]);

/**
 * `source_type` → the plain-English label the LLD's own example uses ("your public website",
 * "public trade records"). [deviation: the LLD gives only these two examples, not an exhaustive
 * mapping for every `knowledge.source.source_type` value (M08); the remaining labels below are
 * this implementation's best-effort extension of that wording, and `sanctions`/`nomenclature`/
 * `user_report`/`operator` are omitted because they are never surfaced as buyer-facing evidence.]
 */
const SOURCE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  website: 'your public website',
  customs: 'public trade records',
  directory: 'public business directories',
  registry: 'public company registries',
  market_stats: 'public trade statistics',
});

const FALLBACK_SOURCE_LABEL = 'public sources';

function joinWithAnd(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** LLD M34 footer bullets, assembled in code. Never throws; missing optional fields are omitted. */
export function buildFooter(profile: FooterBusinessProfile, buyer: FooterBuyer, _language: string): string {
  const lines: string[] = [];

  // "Sender name and business name."
  const sender = profile.senderName.trim();
  const business = profile.businessName.trim();
  if (sender && business && sender !== business) lines.push(`${sender}, ${business}`);
  else lines.push(sender || business);

  // "City and state, and the IEC if present."
  const location = [profile.city, profile.state].filter((v): v is string => !!v && v.trim().length > 0).join(', ');
  if (location) lines.push(location);
  if (profile.iec) lines.push(`IEC: ${profile.iec}`);

  // The opt-out line (literal LLD wording).
  lines.push("Reply 'unsubscribe' and I won't contact you again.");

  // The EU/EEA/UK/CH source-disclosure line.
  if (EU_EEA_UK_CH_COUNTRIES.has(buyer.country.toUpperCase())) {
    const labels = [...new Set(buyer.evidenceSourceTypes.map((t) => SOURCE_TYPE_LABELS[t] ?? FALLBACK_SOURCE_LABEL))];
    if (labels.length > 0) {
      lines.push(`I found your company through ${joinWithAnd(labels)}.`);
    }
  }

  return lines.join('\n');
}
