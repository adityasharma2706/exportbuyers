// Error model (LLD §0.3).

export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_CREDITS'
  | 'POLICY_DENIED'
  | 'SANCTIONS_BLOCKED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'SIGNUP_REQUIRED'
  | 'INTERNAL';

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INSUFFICIENT_CREDITS: 402,
  POLICY_DENIED: 403,
  SANCTIONS_BLOCKED: 403,
  UPSTREAM_UNAVAILABLE: 503,
  SIGNUP_REQUIRED: 401,
  INTERNAL: 500,
});

/** API error envelope returned for every failed request (LLD §0.3). */
export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly http: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.http = ERROR_HTTP_STATUS[code];
    if (details !== undefined) this.details = details;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  /** The API error envelope: `{ error: { code, message, details } }`. */
  toResponseBody(): ErrorResponseBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

/**
 * Build a RATE_LIMITED error. Per LLD §0.3 the response must carry `retryAfterSec`
 * (a whole number of seconds, minimum 1).
 */
export function rateLimited(
  retryAfterSec: number,
  message = 'Too many requests',
  details?: Record<string, unknown>,
): AppError {
  const secs = Number.isFinite(retryAfterSec) ? Math.max(1, Math.ceil(retryAfterSec)) : 1;
  return new AppError('RATE_LIMITED', message, { ...(details ?? {}), retryAfterSec: secs });
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * Normalise any thrown value into an AppError. Unknown errors become INTERNAL
 * carrying the correlation id, so the client can quote it without seeing internals.
 */
export function toAppError(e: unknown, correlationId?: string): AppError {
  if (e instanceof AppError) return e;
  return new AppError(
    'INTERNAL',
    'Internal error',
    correlationId !== undefined ? { correlationId } : undefined,
    { cause: e },
  );
}
