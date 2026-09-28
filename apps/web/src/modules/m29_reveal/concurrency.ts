/**
 * M29 — a small bounded-concurrency map, used for bulk reveal's "processed with a concurrency of
 * 4" (LLD M29 Bulk). Runs `fn` over every item, never more than `limit` in flight, and returns
 * results in the same order as `items` (errors are not swallowed here; callers that want a
 * per-item outcome should have `fn` itself catch and return a result object).
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Array<Promise<void>> = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          results[i] = await fn(items[i] as T, i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}
