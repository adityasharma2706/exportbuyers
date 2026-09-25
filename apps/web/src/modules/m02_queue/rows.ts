/**
 * M02 — driver row shapes for the platform tables other than platform.job (see types.ts).
 */
import type { QueueName } from './types.js';

export interface OutboxRow {
  id: string;
  event_type: string;
  payload: unknown;
  v: number;
  correlation_id: string;
  created_at: Date | string;
}

export interface SubscriptionRow {
  event_type: string;
  handler: string;
  queue: QueueName;
}

export interface ScheduleRow {
  name: string;
  cron: string;
  job_type: string;
  payload: unknown;
  queue: QueueName;
  last_enqueued_at: Date | string | null;
}

export interface RegisteredRateClassRow {
  name: string;
  max_concurrency: number | string;
  per_second: number | string;
}
