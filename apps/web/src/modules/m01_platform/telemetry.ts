/**
 * M01 — OpenTelemetry SDK bootstrap. Exports traces over OTLP/HTTP when an endpoint is
 * configured; otherwise the API stays a no-op and withSpan() costs almost nothing.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { PlatformConfig } from './config.js';
import { log } from './logging.js';

let sdk: { start(): void; shutdown(): Promise<void> } | undefined;

export function initTelemetry(cfg: PlatformConfig): void {
  if (sdk || !cfg.otlpEndpoint) return;
  const endpoint = cfg.otlpEndpoint.replace(/\/+$/, '') + '/v1/traces';
  const instance = new NodeSDK({
    serviceName: cfg.serviceName,
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
  });
  instance.start();
  sdk = instance;
  log.info({ endpoint }, 'telemetry started');
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  const s = sdk;
  sdk = undefined;
  try {
    await s.shutdown();
  } catch (err) {
    log.warn({ err }, 'telemetry shutdown failed');
  }
}
