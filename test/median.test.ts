import { describe, expect, it } from 'vitest';
import { median } from '../src/util/median.js';

describe('median', () => {
  it('returns the middle value for an odd number of values', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the middle two values for an even number of values', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('returns 0 for an empty list', () => {
    expect(median([])).toBe(0);
  });
});
