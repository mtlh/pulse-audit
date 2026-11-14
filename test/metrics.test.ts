import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import {
  API_METRICS,
  AUDIT_METRICS,
  AUDIT_METRIC_KEYS,
  auditMetrics,
  budgetRuleConfigured,
  FAST_SIZE_METRICS,
  FAST_TIMING_METRICS,
  findApiMetric,
  findAuditMetric,
} from '../src/metrics.js';

const BUDGET_KEYS = Object.keys(defaultConfig(['https://example.com/']).budgets)
  .filter((key) => key !== 'a11y')
  .sort();

describe('metric registry', () => {
  it('covers every budget key exactly once', () => {
    expect(AUDIT_METRICS.map((metric) => metric.key).sort()).toEqual(BUDGET_KEYS);
    expect(new Set(AUDIT_METRICS.map((metric) => metric.key)).size).toBe(AUDIT_METRICS.length);
  });

  it('covers every measured metric and keeps violations last', () => {
    expect([...AUDIT_METRIC_KEYS]).toEqual([...AUDIT_METRICS.map((metric) => metric.key), 'violations']);

    const metrics = auditMetrics();
    expect(Object.keys(metrics).sort()).toEqual([...AUDIT_METRIC_KEYS].sort());
    expect(Object.values(metrics).every((value) => value === 0)).toBe(true);
  });

  it('partitions page metrics between the fast path size and timing lanes', () => {
    const fastKeys = [...FAST_SIZE_METRICS, ...FAST_TIMING_METRICS].sort();
    expect(fastKeys).toEqual(BUDGET_KEYS);
    expect(FAST_SIZE_METRICS.filter((key) => FAST_TIMING_METRICS.includes(key))).toEqual([]);
  });

  it('exposes a definition and a label for every metric', () => {
    for (const metric of AUDIT_METRICS) {
      expect(findAuditMetric(metric.key)).toBe(metric);
      expect(metric.label.length).toBeGreaterThan(0);
    }
    for (const metric of API_METRICS) {
      expect(findApiMetric(metric.key)).toBe(metric);
      expect(metric.label.length).toBeGreaterThan(0);
    }
    expect(findAuditMetric('not-a-metric')).toBeUndefined();
  });

  it('treats only rules with max or regression as configured', () => {
    expect(budgetRuleConfigured(undefined)).toBe(false);
    expect(budgetRuleConfigured({ severity: 'warn' })).toBe(false);
    expect(budgetRuleConfigured({ max: 0 })).toBe(true);
    expect(budgetRuleConfigured({ regression: 0 })).toBe(true);
  });

  it('fills a complete metric set from partial overrides', () => {
    const metrics = auditMetrics({ lcp: 1200, violations: 2 });
    const missing = AUDIT_METRIC_KEYS.filter((key) => !(key in metrics));

    expect(missing).toEqual([]);
    expect(metrics.lcp).toBe(1200);
    expect(metrics.violations).toBe(2);
    expect(metrics).toMatchObject({ lcp: 1200, violations: 2 });
  });
});
