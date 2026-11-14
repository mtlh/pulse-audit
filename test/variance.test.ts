import { describe, expect, it } from 'vitest';
import { AUDIT_METRIC_KEYS, metricSpreads, metricStat } from '../src/util/variance.js';
import type { AuditMetrics } from '../src/types.js';

function metrics(overrides: Partial<AuditMetrics> = {}): AuditMetrics {
  return {
    lcp: 0,
    cls: 0,
    tbt: 0,
    fcp: 0,
    ttfb: 0,
    js: 0,
    css: 0,
    fonts: 0,
    images: 0,
    total: 0,
    requests: 0,
    failedRequests: 0,
    thirdPartyBytes: 0,
    thirdPartyRequests: 0,
    longTasks: 0,
    thirdPartyMainThread: 0,
    consoleErrors: 0,
    violations: 0,
    ...overrides,
  };
}

describe('metricStat', () => {
  it('returns min, median, max and spread percentage', () => {
    expect(metricStat([200, 100, 300])).toEqual({
      min: 100,
      median: 200,
      max: 300,
      spreadPct: 100,
    });
  });

  it('averages the middle pair for an even number of values', () => {
    expect(metricStat([10, 20, 30, 40])).toEqual({
      min: 10,
      median: 25,
      max: 40,
      spreadPct: 120,
    });
  });

  it('reports a zero spread when the median is zero', () => {
    expect(metricStat([0, 0, 0])).toEqual({ min: 0, median: 0, max: 0, spreadPct: 0 });
  });

  it('handles an empty list', () => {
    expect(metricStat([])).toEqual({ min: 0, median: 0, max: 0, spreadPct: 0 });
  });

  it('ignores non-finite values', () => {
    expect(metricStat([100, Number.NaN, 300])).toEqual({
      min: 100,
      median: 200,
      max: 300,
      spreadPct: 100,
    });
  });
});

describe('metricSpreads', () => {
  it('computes a stat for every numeric metric key', () => {
    const samples = [
      metrics({ lcp: 1000, tbt: 100, longTasks: 1, failedRequests: 1, violations: 1 }),
      metrics({ lcp: 2000, tbt: 200, longTasks: 2, failedRequests: 2, violations: 2 }),
      metrics({ lcp: 3000, tbt: 300, longTasks: 3, failedRequests: 3, violations: 3 }),
    ];

    const spreads = metricSpreads(samples);

    expect(AUDIT_METRIC_KEYS).toHaveLength(18);
    for (const key of AUDIT_METRIC_KEYS) {
      expect(spreads[key]).toBeDefined();
    }
    expect(spreads.lcp).toEqual({ min: 1000, median: 2000, max: 3000, spreadPct: 100 });
    expect(spreads.tbt).toEqual({ min: 100, median: 200, max: 300, spreadPct: 100 });
    expect(spreads.longTasks).toEqual({ min: 1, median: 2, max: 3, spreadPct: 100 });
    expect(spreads.violations).toEqual({ min: 1, median: 2, max: 3, spreadPct: 100 });
    expect(spreads.failedRequests).toEqual({ min: 1, median: 2, max: 3, spreadPct: 100 });
    expect(spreads.js).toEqual({ min: 0, median: 0, max: 0, spreadPct: 0 });
  });
});
