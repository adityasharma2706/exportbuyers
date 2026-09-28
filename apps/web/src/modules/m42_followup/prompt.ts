/**
 * M42 — builds the follow-up LLM prompt. LLD M42: "the same policy, sanctions and footer steps as
 * M34 apply", and "thread context = the parent draft's body_edited ?? body_generated". The prompt
 * shape mirrors M34's own buildDraftPrompt (seller profile, HS code, buyer name/country, at most
 * N company-level evidence snippets, never a contact value or a person's name, no certification
 * claims beyond the profile, no footer), plus the parent thread's own text as context.
 */
import { sanitizeSnippet, type DraftTone, type EvidenceSnippet } from '../m34_draft/index.js';

export interface FollowUpPromptInput {
  /** 2 = follow_up_1 (the "second touch"), 3 = follow_up_2 (the "third touch") — LLD M42 title. */
  touch: 2 | 3;
  tone: DraftTone;
  /** ISO-639-1 code (LLD M34/M42 API). */
  language: string;
  businessName: string;
  whatTheyMake: string | null;
  city: string | null;
  hsCode: string | null;
  buyerName: string;
  buyerCountry: string;
  /** The parent draft's `body_edited ?? body_generated` (LLD M42 Rules). */
  threadContext: string;
  evidence: EvidenceSnippet[];
}

/**
 * A small duplicate of M34's own (unexported) language-name table — see that module's prompt.ts.
 * Not reused directly because M34's index.ts exports no `languageName` helper.
 */
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

export function buildFollowUpPrompt(input: FollowUpPromptInput): { system: string; user: string } {
  const langName = languageName(input.language);
  const ordinal = input.touch === 2 ? 'second' : 'third and final';
  const system = [
    `You draft a short, polite follow-up outreach message (the ${ordinal} touch) from an Indian exporter to an overseas buyer who has not yet replied to an earlier message.`,
    `Write the entire message in ${langName}.`,
    `Tone: ${input.tone === 'formal' ? 'formal and professional' : 'friendly and warm, while still professional'}.`,
    'Rules:',
    "- Do not claim any certification, verification, membership or accreditation that is not explicitly stated in the seller's profile below.",
    "- Never address the buyer by a person's name and never invent one; address their company only.",
    '- Do not include a signature block, sender name, phone number, email address, physical address, or any closing/opt-out line — those are appended separately.',
    '- Briefly acknowledge this is a follow-up to an earlier message, without quoting it verbatim; add one new, concrete reason to reply (a fresh detail, a brief value point, or a simple question).',
    '- Reference the shared evidence naturally, in your own words, only if it is useful; do not quote it verbatim and do not name the data source.',
    input.touch === 3
      ? '- This is the final planned follow-up on this thread: politely note that this will be the last check-in for now, without sounding impatient or pushy.'
      : '- Keep the tone light and low-pressure; this is only the first reminder.',
    '- Keep it short: roughly 60-120 words, one short paragraph, ending with a simple call to action.',
    '- Output only the message body: no subject line, no preamble, no markdown formatting.',
  ].join('\n');

  const lines: string[] = ['Seller profile:', `- Business name: ${input.businessName}`];
  if (input.whatTheyMake) lines.push(`- What they make: ${input.whatTheyMake}`);
  if (input.city) lines.push(`- City: ${input.city}`);
  if (input.hsCode) lines.push(`- HS code: ${input.hsCode}`);
  lines.push('', 'Buyer:', `- Company name: ${input.buyerName}`, `- Country: ${input.buyerCountry}`);
  lines.push(
    '',
    'The earlier message this follows up on (background only; paraphrase, never quote verbatim):',
    sanitizeSnippet(input.threadContext),
  );
  if (input.evidence.length > 0) {
    lines.push('', 'Evidence this buyer is relevant (paraphrase only; do not quote or name the source):');
    for (const e of input.evidence) lines.push(`- ${sanitizeSnippet(e.snippet)}`);
  }
  return { system, user: lines.join('\n') };
}
