/**
 * M05 — input validation and normalisation for OTP destinations and request bodies.
 */
import { AppError, isUuid } from '../m01_platform/index.js';
import { identityConfig } from './config.js';

export type OtpChannel = 'sms' | 'email';

export function isValidE164(s: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(s);
}

export function isValidEmail(s: string): boolean {
  if (s.length < 3 || s.length > 254) return false;
  // Pragmatic check: one @, non-empty local part (≤64), dotted domain, no whitespace.
  const m = /^([^\s@]{1,64})@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/.exec(s);
  return m !== null;
}

/** Strips spaces, dashes, dots and parentheses; converts a leading 00 to +. */
export function normalisePhone(raw: string): string {
  let s = raw.trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  return s;
}

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Validates a destination for the channel and returns its normalised form.
 * SMS: E.164 only, and only allowed prefixes (+91 at launch); others get VALIDATION with
 * details.suggestChannel='email' so the UI can offer email instead.
 */
export function normaliseDestination(channel: OtpChannel, destination: unknown): string {
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new AppError('VALIDATION', 'destination is required', { field: 'destination' });
  }
  if (channel === 'sms') {
    const phone = normalisePhone(destination);
    if (!isValidE164(phone)) {
      throw new AppError('VALIDATION', 'Phone number must be in international format, e.g. +919812345678', {
        field: 'destination',
        reason: 'not_e164',
        suggestChannel: 'email',
      });
    }
    const allowed = identityConfig().otp.smsAllowedPrefixes;
    if (!allowed.some((p) => phone.startsWith(p))) {
      throw new AppError('VALIDATION', 'SMS sign-in is only available for Indian mobile numbers; use email instead', {
        field: 'destination',
        reason: 'country_not_supported',
        suggestChannel: 'email',
      });
    }
    if (phone.startsWith('+91') && !/^\+91[6-9]\d{9}$/.test(phone)) {
      throw new AppError('VALIDATION', 'Not a valid Indian mobile number', {
        field: 'destination',
        reason: 'invalid_mobile',
        suggestChannel: 'email',
      });
    }
    return phone;
  }
  const email = normaliseEmail(destination);
  if (!isValidEmail(email)) {
    throw new AppError('VALIDATION', 'Invalid email address', { field: 'destination', reason: 'invalid_email' });
  }
  return email;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('VALIDATION', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export interface OtpRequestBody {
  channel: OtpChannel;
  destination: string;
}

export function parseOtpRequest(body: unknown): OtpRequestBody {
  const o = asObject(body);
  if (o.channel !== 'sms' && o.channel !== 'email') {
    throw new AppError('VALIDATION', "channel must be 'sms' or 'email'", { field: 'channel' });
  }
  if (typeof o.destination !== 'string') throw new AppError('VALIDATION', 'destination is required', { field: 'destination' });
  return { channel: o.channel, destination: o.destination };
}

export interface OtpVerifyBody {
  challengeId: string;
  code: string;
}

export function parseOtpVerify(body: unknown): OtpVerifyBody {
  const o = asObject(body);
  if (typeof o.challengeId !== 'string' || !isUuid(o.challengeId)) {
    throw new AppError('VALIDATION', 'challengeId is invalid', { field: 'challengeId' });
  }
  const code = typeof o.code === 'string' ? o.code.trim() : '';
  if (!/^\d{6}$/.test(code)) throw new AppError('VALIDATION', 'code must be 6 digits', { field: 'code' });
  return { challengeId: o.challengeId, code };
}

export function parseMfaVerify(body: unknown): { totp: string } {
  const o = asObject(body);
  const totp = typeof o.totp === 'string' ? o.totp.trim() : '';
  if (!/^\d{6}$/.test(totp)) throw new AppError('VALIDATION', 'totp must be 6 digits', { field: 'totp' });
  return { totp };
}
