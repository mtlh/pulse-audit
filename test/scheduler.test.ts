import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/scheduler.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mapWithConcurrency', () => {
  it('returns results in input order even when work finishes out of order', async () => {
    const result = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await delay(ms);
      return ms;
    });

    expect(result).toEqual([30, 10, 20]);
  });

  it('never runs more than the limit at once', async () => {
    let active = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(5);
      active -= 1;
      return item;
    });

    expect(peak).toBe(2);
  });

  it('keeps a single worker strictly sequential', async () => {
    const order: string[] = [];

    await mapWithConcurrency([1, 2, 3], 1, async (item) => {
      order.push(`start ${item}`);
      await delay(1);
      order.push(`end ${item}`);
    });

    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  it('drains in-flight work before rethrowing the first failure', async () => {
    let finished = 0;

    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 1) throw new Error('boom');
        await delay(5);
        finished += 1;
        return item;
      }),
    ).rejects.toThrow('boom');

    // Item 2 started alongside item 1 and was allowed to finish; item 3 never starts.
    expect(finished).toBe(1);
  });

  it('rejects an invalid limit and handles an empty list', async () => {
    await expect(mapWithConcurrency([1], 0, async () => 1)).rejects.toThrow(/positive integer/);
    await expect(mapWithConcurrency([], 2, async () => 1)).resolves.toEqual([]);
  });
});
