/**
 * M32 — request validation for POST /api/check (IF-32a). Pure; no I/O.
 */
import { z } from 'zod';
import { AppError } from '../m01_platform/index.js';
import type { CheckBuyerRequestDto } from './types.js';

export const checkBuyerRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(500).optional(),
    email: z.string().trim().min(3).max(320).optional(),
    website: z.string().trim().min(1).max(2048).optional(),
    country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'country must be ISO 3166-1 alpha-2').optional(),
    messageText: z.string().max(4000).optional(),
  })
  .strict();

/** LLD IF-32a: "at least one of name/email/website". */
export function parseCheckBuyerRequest(body: unknown): CheckBuyerRequestDto {
  const r = checkBuyerRequestSchema.safeParse(body ?? {});
  if (!r.success) throw new AppError('VALIDATION', 'Invalid buyer-check request', { issues: r.error.issues });
  const { name, email, website, country, messageText } = r.data;
  if (!name && !email && !website) {
    throw new AppError('VALIDATION', 'Send at least one of name, email or website', { field: 'name' });
  }
  const out: CheckBuyerRequestDto = {};
  if (name) out.name = name;
  if (email) out.email = email;
  if (website) out.website = website;
  if (country) out.country = country.toUpperCase();
  if (messageText && messageText.trim()) out.messageText = messageText;
  return out;
}
