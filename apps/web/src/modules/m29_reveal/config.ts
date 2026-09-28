/**
 * M29 — tunables (LLD M29 and, for the staleness threshold, LLD M25's `CONTACT_STALE_DAYS`).
 */

/** LLD M25: "about 90 days" for contacts. Mirrored here (rather than imported) because M25's
 * threshold lives in the Python knowledge plane (py/kp/m25_freshness/pipeline.py); the two must
 * be kept in step by hand if the tunable changes. [tunable] */
export const CONTACT_STALE_DAYS = 90;

/** LLD M25 rpc.py: at most 500 assertion ids per /rpc/reverify call. */
export const REVERIFY_MAX_IDS = 500;

/** LLD M29 Bulk: "the request must finish within 60 s. If the batch is large, the request is
 * processed as a job." Batches of at most this many not-yet-revealed companies run inline;
 * larger batches are queued. At ~4 companies in flight and a worst case of a few seconds per
 * company (policy + sanctions + reverify + value fetch), 20 companies comfortably clears the
 * 60 s budget even under load. [tunable] */
export const INLINE_BULK_MAX = 20;

/** LLD M29 Bulk: "processed with a concurrency of 4." */
export const BULK_CONCURRENCY = 4;

export const BULK_JOB_TYPE = 'm29.reveal_bulk';
export const BULK_JOB_QUEUE = 'serving' as const;
export const BULK_RATE_CLASS = 'm29.reveal_bulk';
