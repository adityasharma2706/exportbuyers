/**
 * M01 — shared Redis client (ElastiCache in the India region).
 */
import { Redis } from 'ioredis';
import type { PlatformConfig } from './config.js';
import { isIndiaRegion } from './config.js';
import { AppError } from './errors.js';
import { log } from './logging.js';
import { getSecret } from './secrets.js';

/** The subset of the Redis API the platform relies on; lets tests supply an in-memory fake. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<unknown>;
}

let client: RedisLike | undefined;

/** ElastiCache hostnames embed the region; refuse identifiable non-India endpoints. */
export function assertRedisHostInIndia(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new AppError('INTERNAL', 'REDIS_URL is not a valid URL');
  }
  const m = /\.([a-z]{2}-[a-z]+-\d)\.cache\.amazonaws\.com$/i.exec(host);
  if (m && !isIndiaRegion(m[1]!)) {
    throw new AppError('INTERNAL', `Redis host is in ${m[1]}, outside India`, { region: m[1] });
  }
}

export function initRedis(cfg: PlatformConfig, opts: { url?: string; client?: RedisLike } = {}): RedisLike {
  if (client) return client;
  if (opts.client) {
    client = opts.client;
    return client;
  }
  const url = opts.url ?? getSecret('REDIS_URL');
  assertRedisHostInIndia(url);
  const r = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    connectionName: cfg.serviceName,
  });
  r.on('error', (err: Error) => log.error({ err }, 'redis error'));
  client = r as RedisLike;
  return client;
}

export function getRedis(): RedisLike {
  if (!client) throw new AppError('INTERNAL', 'Redis not initialised; call initRedis() at boot');
  return client;
}

export async function closeRedis(): Promise<void> {
  const c = client;
  client = undefined;
  if (c) await c.quit();
}
