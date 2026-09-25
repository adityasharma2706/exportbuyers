/**
 * M01 — process boot / shutdown for R1 (web) and R2 (worker).
 * Order: config (India-region guard) → secrets → telemetry → DB → Redis → object store.
 */
import { initConfig, type PlatformConfig } from './config.js';
import { stopCostRecorder } from './cost.js';
import { closeDb, initDb } from './db.js';
import { log } from './logging.js';
import { closeRedis, initRedis } from './redis.js';
import { loadSecrets } from './secrets.js';
import { initObjectStore } from './storage.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';

export async function bootPlatform(env: NodeJS.ProcessEnv = process.env): Promise<PlatformConfig> {
  const cfg = initConfig(env);
  await loadSecrets(cfg);
  initTelemetry(cfg);
  initDb(cfg);
  initRedis(cfg);
  initObjectStore(cfg);
  log.info({ appEnv: cfg.appEnv, region: cfg.region, service: cfg.serviceName }, 'platform booted');
  return cfg;
}

export async function shutdownPlatform(): Promise<void> {
  const steps: Array<[string, () => Promise<void>]> = [
    ['cost', stopCostRecorder],
    ['db', closeDb],
    ['redis', closeRedis],
    ['telemetry', shutdownTelemetry],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      log.error({ err, step: name }, 'shutdown step failed');
    }
  }
}
