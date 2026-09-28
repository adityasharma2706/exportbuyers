/**
 * M44 Outcome events — public API. Other modules import ONLY from this file.
 *
 * REQ-050: status changes to Replied, In discussion or Order won emit outcome events to the
 * `analytics` schema for success metrics and relevance tuning (LLD M44).
 *
 *   events.ts   EV-08 `pipeline.status_changed` handler -> analytics.outcome_event.
 *   repo.ts     The insert (runs inside the event's own transaction).
 *   types.ts    OutcomeEventRow / the three tracked `to_status` values.
 *   systemCtx.ts The background actor used to re-check M10 visibility before writing.
 *
 * Call registerOutcomeEventsModule() once at boot (web and worker), after M33 has loaded.
 */
export { buildOutcomeEventRows, registerOutcomeEventsModule, resetOutcomeEventsModuleForTesting } from './events.js';
export { insertOutcomeEvents } from './repo.js';
export { systemCtxFor } from './systemCtx.js';
export { isOutcomeToStatus, OUTCOME_TO_STATUSES } from './types.js';
export type { OutcomeEventRow, OutcomeToStatus } from './types.js';
