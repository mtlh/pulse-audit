/**
 * Runs `fn` for every item with at most `limit` calls in flight. Results keep
 * the input order, so a caller can build a deterministic report even when the
 * work finishes out of order.
 *
 * A rejected item does not abandon work that is already running: every worker
 * drains before the first failure is rethrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Concurrency must be a positive integer, received ${limit}`);
  }
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  const workers = Math.min(limit, items.length);
  let next = 0;
  let stopping = false;
  const failures: unknown[] = [];

  const worker = async (): Promise<void> => {
    while (!stopping) {
      const index = next;
      next += 1;
      if (index >= items.length) return;

      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failures.push(error);
        // Stop scheduling new work; workers already in flight still drain.
        stopping = true;
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
  if (failures.length > 0) throw failures[0];
  return results;
}
