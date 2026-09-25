/**
 * M01 — structured logging and tracing (IF-01c).
 *
 *   const log: pino.Logger
 *   function withSpan<T>(name, fn): Promise<T>
 *
 * The correlation id of the current request/job is carried in AsyncLocalStorage and added
 * to every log line and span automatically.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';

interface LogContext {
  correlationId: string;
  accountId?: string;
  workspaceId?: string;
  jobType?: string;
}

const als = new AsyncLocalStorage<LogContext>();

/** Paths that must never reach log storage in clear text. */
export const REDACT_PATHS: readonly string[] = [
  'password',
  '*.password',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'DATABASE_URL',
  'REDIS_URL',
  'email',
  '*.email',
  'phone',
  '*.phone',
];

function buildLogger(): pino.Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? (process.env.APP_ENV === 'production' ? 'info' : 'debug'),
    base: {
      service: process.env.SERVICE_NAME ?? 'web',
      env: process.env.APP_ENV ?? 'local',
      region: process.env.AWS_REGION ?? 'ap-south-1',
    },
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    mixin() {
      const c = als.getStore();
      if (!c) return {};
      const span = trace.getActiveSpan();
      const sc = span?.spanContext();
      return {
        correlationId: c.correlationId,
        ...(c.accountId ? { accountId: c.accountId } : {}),
        ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
        ...(c.jobType ? { jobType: c.jobType } : {}),
        ...(sc ? { traceId: sc.traceId, spanId: sc.spanId } : {}),
      };
    },
  });
}

export const log: pino.Logger = buildLogger();

/** Runs fn with a correlation context; all logs and spans inside carry it. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function currentCorrelationId(): string | undefined {
  return als.getStore()?.correlationId;
}

export function currentLogContext(): Readonly<LogContext> | undefined {
  return als.getStore();
}

const tracer = trace.getTracer('exportbuyers.m01_platform');

/**
 * Wraps fn in an OpenTelemetry span. Errors are recorded on the span and re-thrown unchanged.
 * When no tracer provider is registered this is a cheap no-op span.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span: Span) => {
    const c = als.getStore();
    if (c) span.setAttribute('correlation_id', c.correlationId);
    if (attributes) span.setAttributes(attributes);
    try {
      const out = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
