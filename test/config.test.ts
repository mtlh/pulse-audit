import { describe, expect, it } from 'vitest';
import { budgetsFromResult, configSchema, defaultConfig } from '../src/config.js';
import type { AuditResult } from '../src/types.js';

function result(metrics: Partial<AuditResult['metrics']> = {}): AuditResult {
  return {
    url: 'https://example.com/',
    preset: 'mobile',
    runs: 1,
    capturedAt: '2026-11-02T00:00:00.000Z',
    metrics: { lcp: 1600, cls: 0.01, tbt: 50, js: 100_000, images: 200_000, requests: 3, violations: 2, ...metrics },
    heaviest: [],
    violations: [],
  };
}

describe('config', () => {
  it('round-trips the default config', () => {
    const parsed = configSchema.parse(defaultConfig(['https://example.com/']));
    expect(parsed.preset).toBe('mobile');
    expect(parsed.runs).toBe(3);
    expect(parsed.report.outDir).toBe('.pulse');
    expect(parsed.budgets.lcp?.max).toBe(2500);
  });

  it('applies defaults to a minimal config', () => {
    const parsed = configSchema.parse({ urls: ['https://example.com/'] });
    expect(parsed.preset).toBe('mobile');
    expect(parsed.runs).toBe(3);
    expect(parsed.report.outDir).toBe('.pulse');
  });

  it('rejects an invalid preset', () => {
    const parsed = configSchema.safeParse({ urls: ['https://example.com/'], preset: 'tablet' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-URL', () => {
    const parsed = configSchema.safeParse({ urls: ['not-a-url'] });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown keys instead of silently ignoring typos', () => {
    const parsed = configSchema.safeParse({ urls: ['https://example.com/'], budgest: {} });
    expect(parsed.success).toBe(false);
  });
});

describe('budgetsFromResult', () => {
  it('adds the documented headroom to a measured page', () => {
    const budgets = budgetsFromResult(result());

    expect(budgets.lcp?.max).toBe(2100);
    expect(budgets.cls?.max).toBe(0.05);
    expect(budgets.tbt?.max).toBe(200);
    expect(budgets.js?.max).toBe(120832);
    expect(budgets.images?.max).toBe(240640);
    expect(budgets.requests?.max).toBe(20);
    expect(budgets.a11y).toEqual({ maxViolations: 2, maxNew: 0 });
  });

  it('keeps floors so a tiny page does not get an unhittable budget', () => {
    const budgets = budgetsFromResult(result({ lcp: 100, js: 1000, images: 1000, requests: 1, violations: 0 }));

    expect(budgets.lcp?.max).toBe(1000);
    expect(budgets.js?.max).toBe(50_000);
    expect(budgets.images?.max).toBe(100_000);
    expect(budgets.requests?.max).toBe(20);
    expect(budgets.a11y?.maxViolations).toBe(0);
  });
});
