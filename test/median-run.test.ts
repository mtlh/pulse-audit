import { describe, expect, it } from 'vitest';
import { pickMedianRun } from '../src/runner.js';
import type { AuditMetrics, AuditResult } from '../src/types.js';

function audit(label: string, metrics: Partial<AuditMetrics>): AuditResult {
  return {
    url: 'https://example.com/',
    preset: 'mobile',
    runs: 3,
    capturedAt: '2026-11-02T00:00:00.000Z',
    metrics: {
      lcp: 0,
      cls: 0,
      tbt: 0,
      js: 0,
      images: 0,
      requests: 0,
      violations: 0,
      ...metrics,
    },
    lcpElement: { selector: label },
    heaviest: [],
    violations: [],
  };
}

describe('pickMedianRun', () => {
  it('returns the only run untouched', () => {
    const only = audit('only', { lcp: 1200 });
    expect(pickMedianRun([only])).toBe(only);
  });

  it('medians numeric metrics and keeps details from the median-LCP run', () => {
    const fast = audit('fast', {
      lcp: 1000,
      cls: 0.01,
      tbt: 10,
      js: 100,
      images: 200,
      requests: 10,
      violations: 1,
    });
    const middle = audit('middle', {
      lcp: 2000,
      cls: 0.04,
      tbt: 60,
      js: 300,
      images: 400,
      requests: 20,
      violations: 4,
    });
    const slow = audit('slow', {
      lcp: 3000,
      cls: 0.09,
      tbt: 100,
      js: 500,
      images: 600,
      requests: 30,
      violations: 9,
    });

    const picked = pickMedianRun([slow, fast, middle]);

    expect(picked.lcpElement?.selector).toBe('middle');
    expect(picked.metrics).toEqual({
      lcp: 2000,
      cls: 0.04,
      tbt: 60,
      js: 300,
      images: 400,
      requests: 20,
      // Tied to the violation array that ships with the report, not medianed.
      violations: 4,
    });
  });

  it('averages the two middle values for an even number of runs', () => {
    const picked = pickMedianRun([
      audit('a', { lcp: 1000, tbt: 10 }),
      audit('b', { lcp: 2000, tbt: 20 }),
      audit('c', { lcp: 3000, tbt: 30 }),
      audit('d', { lcp: 4000, tbt: 40 }),
    ]);

    expect(picked.metrics.lcp).toBe(2500);
    expect(picked.metrics.tbt).toBe(25);
  });
});
