/**
 * M34 — builds the LLM prompt (LLD M34 sequence step 3): the business profile (name, product,
 * city), the HS description, at most `maxEvidenceSnippets` company-level evidence snippets, and
 * the buyer's company name and country. Never a contact value or a person's name; "no claims of
 * certification or verification not present in the profile; no footer".
 *
 * [deviation: the LLD calls for "the HS description", which in this codebase's other modules
 * (M12/M13, the HS nomenclature store and helper) means the nomenclature's human-readable text
 * for a code. M34's declared deps (docs/implementer.md: M03, M07, M10, M27, M33) do not include
 * either module, so no such lookup is available here. This uses the seller's own workspace HS
 * code (M07 `Workspace.hs.code`, a plain string like "8471") in its place. If M12/M13 become an
 * available dependency later, `hsCode` below should be replaced with the looked-up description.]
 */
import type { ProfileDoc } from '../m10_policy/index.js';
import type { DraftTone } from './types.js';

export interface EvidenceSnippet {
  snippet: string;
  sourceType: string;
  hsHeading: string;
}

export interface DraftPromptInput {
  tone: DraftTone;
  /** ISO-639-1 code (LLD M34 API). */
  language: string;
  businessName: string;
  whatTheyMake: string | null;
  city: string | null;
  /** The seller's own HS code, or null (see the module doc comment's deviation note). */
  hsCode: string | null;
  buyerName: string;
  buyerCountry: string;
  evidence: EvidenceSnippet[];
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese',
  it: 'Italian', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ru: 'Russian',
  nl: 'Dutch', tr: 'Turkish', vi: 'Vietnamese', th: 'Thai', id: 'Indonesian', pl: 'Polish',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', el: 'Greek', he: 'Hebrew',
  pa: 'Punjabi', bn: 'Bengali', ur: 'Urdu', fa: 'Persian', ms: 'Malay', uk: 'Ukrainian',
  cs: 'Czech', ro: 'Romanian', hu: 'Hungarian', sw: 'Swahili',
});

function languageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] ?? `the language with ISO 639-1 code "${code}"`;
}

// Best-effort scrub: evidence snippets must never carry a contact value into the prompt (LLD
// sequence step 3: "Never a contact value or a person's name"). M03's own PII guard does not run
// here because draft calls set piiFree: false (LLD M03 Rules), so this module is responsible.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;

export function sanitizeSnippet(s: string): string {
  return s.replace(EMAIL_RE, '[redacted]').replace(PHONE_RE, '[redacted]');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** At most `max` company-level evidence snippets from M10's `ProfileDoc.evidence` (LLD M34
 * sequence step 3), skipping entries with no usable snippet text. */
export function pickEvidenceSnippets(doc: ProfileDoc, max: number): EvidenceSnippet[] {
  const out: EvidenceSnippet[] = [];
  const raw = Array.isArray(doc.evidence) ? doc.evidence : [];
  for (const item of raw) {
    if (out.length >= max) break;
    if (!isRecord(item)) continue;
    const snippet = item.snippet;
    if (typeof snippet !== 'string' || snippet.trim().length === 0) continue;
    const sourceType = typeof item.source_type === 'string' ? item.source_type : 'unknown';
    const hsHeading = typeof item.hs_heading === 'string' ? item.hs_heading : '';
    out.push({ snippet: snippet.trim(), sourceType, hsHeading });
  }
  return out;
}

export function buildDraftPrompt(input: DraftPromptInput): { system: string; user: string } {
  const langName = languageName(input.language);
  const system = [
    'You draft a short first-contact outreach message from an Indian exporter to a potential overseas buyer.',
    `Write the entire message in ${langName}.`,
    `Tone: ${input.tone === 'formal' ? 'formal and professional' : 'friendly and warm, while still professional'}.`,
    'Rules:',
    "- Do not claim any certification, verification, membership or accreditation that is not explicitly stated in the seller's profile below.",
    "- Never address the buyer by a person's name and never invent one; address their company only.",
    '- Do not include a signature block, sender name, phone number, email address, physical address, or any closing/opt-out line — those are appended separately.',
    '- Reference the shared evidence naturally, in your own words; do not quote it verbatim and do not name the data source.',
    '- Keep it to roughly 120-180 words, one or two short paragraphs, ending with a simple call to action (for example, asking whether they would like more details or a quote).',
    '- Output only the message body: no subject line, no preamble, no markdown formatting.',
  ].join('\n');

  const lines: string[] = ['Seller profile:', `- Business name: ${input.businessName}`];
  if (input.whatTheyMake) lines.push(`- What they make: ${input.whatTheyMake}`);
  if (input.city) lines.push(`- City: ${input.city}`);
  if (input.hsCode) lines.push(`- HS code: ${input.hsCode}`);
  lines.push('', 'Buyer:', `- Company name: ${input.buyerName}`, `- Country: ${input.buyerCountry}`);
  if (input.evidence.length > 0) {
    lines.push('', 'Evidence this buyer is relevant (paraphrase only; do not quote or name the source):');
    for (const e of input.evidence) lines.push(`- ${sanitizeSnippet(e.snippet)}`);
  }
  return { system, user: lines.join('\n') };
}
