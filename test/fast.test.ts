import { describe, expect, it } from 'vitest';
import {
  decideFastPath,
  fastAuditResult,
  timingBudgetsConfigured,
  type FastMeasurement,
} from '../src/fast.js';
import type { AuditMetrics, AuditResult, A11yViolation, BudgetSet } from '../src/types.js';

function metrics(overrides: Partial<AuditMetrics> = {}): AuditMetrics {
  return {
    lcp: 0,
    cls: 0,
    tbt: 0,
    fcp: 0,
    ttfb: 0,
    js: 100_000,
    css: 10_000,
    fonts: 0,
    images: 50_000,
    total: 160_000,
    requests: 4,
    thirdPartyBytes: 0,
    thirdPartyRequests: 0,
    violations: 1,
    ...overrides,
  };
}

const contrast: A11yViolation = {
  id: 'color-contrast',
  title: 'Elements must meet minimum color contrast ratio thresholds',
  impact: 'serious',
  nodes: [{ selector: 'p.low', impact: 'serious', failureSummary: 'Fix contrast' }],
};

function measurement(overrides: Partial<FastMeasurement> = {}): FastMeasurement {
  return {
    url: 'https://example.com/',
    status: 200,
    metrics: metrics(),
    requests: [
      { url: 'https://example.com/', resourceType: 'Document', bytes: 100_000, thirdParty: false },
      { url: 'https://example.com/app.js', resourceType: 'Script', bytes: 60_000, thirdParty: false },
    ],
    violations: [contrast],
    ...overrides,
  };
}

function baseline(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    url: 'https://example.com/',
    preset: 'mobile',
    runs: 3,
    capturedAt: '2026-11-01T00:00:00.000Z',
    lighthouseVersion: '13.6.0',
    metrics: metrics(),
    heaviest: [],
    violations: [
      {
        id: 'color-contrast',
        title: 'Contrast',
        impact: 'serious',
        nodes: [{ selector: 'p', impact: 'serious', failureSummary: 'Fix contrast' }],
      },
    ],
    ...overrides,
  };
}

const budgets: BudgetSet = {
  js: { max: 500_000, regression: 20 },
  images: { max: 500_000, regression: 20 },
  requests: { max: 50, regression: 20 },
  a11y: { maxViolations: 10, maxNew: 0 },
};

const config = { budgets, preset: 'mobile' as const, runs: 3 };

describe('timingBudgetsConfigured', () => {
  it('ignores inherited timing rules and names configured ones', () => {
    expect(timingBudgetsConfigured(budgets)).toEqual([]);
    expect(timingBudgetsConfigured({ ...budgets, lcp: { regression: 10 } })).toEqual(['lcp']);
  });
});

describe('decideFastPath', () => {
  it('accepts a fast result when the baseline and every enforced budget agree', () => {
    const decision = decideFastPath({
      measurement: measurement(),
      baseline: baseline(),
      config,
      lighthouseVersion: '13.6.0',
    });

    expect(decision.useFast).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.enforcedBudgets).toEqual(['a11y', 'js', 'images', 'requests']);
  });

  it('escalates whenever a timing budget is configured', () => {
    const decision = decideFastPath({
      measurement: measurement(),
      baseline: baseline(),
      config: { ...config, budgets: { ...budgets, lcp: { max: 2500, regression: 10 } } },
      lighthouseVersion: '13.6.0',
    });

    expect(decision.useFast).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/timing budgets need Lighthouse \(lcp\)/);
  });

  it('escalates without a comparable baseline', () => {
    expect(
      decideFastPath({
        measurement: measurement(),
        baseline: null,
        config,
        lighthouseVersion: '13.6.0',
      }).useFast,
    ).toBe(false);

    expect(
      decideFastPath({
        measurement: measurement(),
        baseline: baseline({ runs: 2 }),
        config,
        lighthouseVersion: '13.6.0',
      }).reasons,
    ).toContain('baseline run count changed');
  });

  it('escalates when accessibility findings differ', () => {
    const decision = decideFastPath({
      measurement: measurement({
        violations: [
          ...measurement().violations,
          {
            id: 'image-alt',
            title: 'Images must have alternate text',
            impact: 'critical',
            nodes: [{ selector: 'img', impact: 'critical' }],
          },
        ],
      }),
      baseline: baseline(),
      config,
      lighthouseVersion: '13.6.0',
    });

    expect(decision.useFast).toBe(false);
    expect(decision.reasons).toContain('accessibility findings changed');
  });

  it('escalates when a size budget is within 10% of its max or regresses', () => {
    const near = decideFastPath({
      measurement: measurement({ metrics: metrics({ js: 460_000, total: 460_000 }) }),
      baseline: baseline(),
      config,
      lighthouseVersion: '13.6.0',
    });
    expect(near.useFast).toBe(false);
    expect(near.reasons.join(' ')).toMatch(/js is within 10% of its max/);

    const regressed = decideFastPath({
      measurement: measurement({ metrics: metrics({ js: 130_000 }) }),
      baseline: baseline(),
      config,
      lighthouseVersion: '13.6.0',
    });
    expect(regressed.useFast).toBe(false);
    expect(regressed.reasons.join(' ')).toMatch(/js regressed/);
  });

  it('escalates on a navigation error or an unenforceable config', () => {
    expect(
      decideFastPath({
        measurement: measurement({ status: 500 }),
        baseline: baseline(),
        config,
        lighthouseVersion: '13.6.0',
      }).reasons.join(' '),
    ).toMatch(/HTTP 500/);

    expect(
      decideFastPath({
        measurement: measurement(),
        baseline: baseline(),
        config: { ...config, budgets: {} },
        lighthouseVersion: '13.6.0',
      }).reasons,
    ).toContain('no fast-checkable budgets configured');
  });
});

describe('fastAuditResult', () => {
  it('reports only the metrics the cheap path measured', () => {
    const result = fastAuditResult(measurement(), { preset: 'mobile', runs: 3 }, ['js', 'a11y']);

    expect(result.runs).toBe(3);
    expect(result.preset).toBe('mobile');
    expect(result.metrics.js).toBe(100_000);
    expect(result.metrics.requests).toBe(4);
    expect(result.metrics.lcp).toBe(0);
    expect(result.metrics.violations).toBe(1);
    expect(result.samples).toBeUndefined();
    expect(result.heaviest).toHaveLength(2);
  });
});
