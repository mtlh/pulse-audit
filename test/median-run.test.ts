import { describe, expect, it } from 'vitest';
import { countViolationNodes } from '../src/compare.js';
import { pickMedianRun, runAudit } from '../src/runner.js';
import type { A11yViolation, AuditMetrics, AuditResult } from '../src/types.js';

const BASE_METRICS: AuditMetrics = {
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
  violations: 0,
};

function audit(label: string, metrics: Partial<AuditMetrics>, violations: A11yViolation[] = []): AuditResult {
  return {
    url: 'https://example.com/',
    preset: 'mobile',
    runs: 3,
    capturedAt: '2026-11-02T00:00:00.000Z',
    metrics: { ...BASE_METRICS, ...metrics },
    lcpElement: { selector: label },
    heaviest: [],
    violations,
  };
}

describe('pickMedianRun', () => {
  it('returns a single run with its metrics as the sample', () => {
    const only = audit('only', { lcp: 1200, violations: 1 }, [
      { id: 'image-alt', title: 'Alt', impact: 'serious', nodes: [{ selector: 'img' }] },
    ]);

    const picked = pickMedianRun([only]);
    expect(picked).not.toBe(only);
    expect(picked.metrics).toEqual(only.metrics);
    expect(picked.samples).toEqual([only.metrics]);
  });

  it('medians numeric metrics, records samples and keeps details from the median-LCP run', () => {
    const fast = audit('fast', {
      lcp: 1000,
      cls: 0.01,
      tbt: 10,
      fcp: 900,
      ttfb: 100,
      js: 100,
      css: 10,
      fonts: 20,
      images: 200,
      total: 500,
      requests: 10,
      failedRequests: 1,
      thirdPartyBytes: 50,
      thirdPartyRequests: 1,
      longTasks: 1,
      thirdPartyMainThread: 10,
    });
    const middle = audit('middle', {
      lcp: 2000,
      cls: 0.04,
      tbt: 60,
      fcp: 1900,
      ttfb: 200,
      js: 300,
      css: 30,
      fonts: 40,
      images: 400,
      total: 1000,
      requests: 20,
      failedRequests: 2,
      thirdPartyBytes: 100,
      thirdPartyRequests: 2,
      longTasks: 2,
      thirdPartyMainThread: 20,
    });
    const slow = audit('slow', {
      lcp: 3000,
      cls: 0.09,
      tbt: 100,
      fcp: 2900,
      ttfb: 300,
      js: 500,
      css: 50,
      fonts: 60,
      images: 600,
      total: 1500,
      requests: 30,
      failedRequests: 3,
      thirdPartyBytes: 150,
      thirdPartyRequests: 3,
      longTasks: 3,
      thirdPartyMainThread: 30,
    });

    middle.heaviest = [
      { url: 'https://cdn.example.com/app.js', resourceType: 'Script', bytes: 900, thirdParty: true },
    ];
    middle.thirdPartyHeaviest = [
      { url: 'https://cdn.example.com/app.js', resourceType: 'Script', bytes: 900, thirdParty: true },
    ];

    const picked = pickMedianRun([slow, fast, middle]);

    expect(picked.lcpElement?.selector).toBe('middle');
    expect(picked.heaviest).toBe(middle.heaviest);
    expect(picked.thirdPartyHeaviest).toBe(middle.thirdPartyHeaviest);
    expect(picked.metrics).toEqual({
      lcp: 2000,
      cls: 0.04,
      tbt: 60,
      fcp: 1900,
      ttfb: 200,
      js: 300,
      css: 30,
      fonts: 40,
      images: 400,
      total: 1000,
      requests: 20,
      failedRequests: 2,
      thirdPartyBytes: 100,
      thirdPartyRequests: 2,
      longTasks: 2,
      thirdPartyMainThread: 20,
      violations: 0,
    });
    expect(picked.samples).toEqual([slow.metrics, fast.metrics, middle.metrics]);
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
    expect(picked.samples).toHaveLength(4);
    expect(picked.samples?.map((sample) => sample.lcp)).toEqual([1000, 2000, 3000, 4000]);
  });

  it('unions a11y violations across runs and ties metrics.violations to the union', () => {
    const first = audit('first', { lcp: 1000, violations: 2 }, [
      {
        id: 'color-contrast',
        title: 'Contrast',
        impact: 'serious',
        nodes: [
          { selector: 'p.a', impact: 'serious', failureSummary: 'Fix A' },
          { selector: 'p.b', impact: 'moderate', failureSummary: 'Fix B' },
        ],
      },
    ]);
    const second = audit('second', { lcp: 2000, violations: 2 }, [
      {
        id: 'color-contrast',
        title: 'Contrast',
        impact: 'critical',
        nodes: [
          {
            selector: 'p.a',
            snippet: '<p class="a">',
            impact: 'serious',
            failureSummary: 'Fix  A',
          },
          { selector: 'p.c', impact: 'critical', failureSummary: 'Fix C' },
        ],
      },
    ]);
    const third = audit('third', { lcp: 3000, violations: 2 }, [
      {
        id: 'color-contrast',
        title: 'Contrast',
        impact: 'serious',
        nodes: [{ selector: 'p.a', impact: 'serious', failureSummary: 'Fix A' }],
      },
      {
        id: 'image-alt',
        title: 'Alt text',
        impact: 'serious',
        nodes: [{ selector: 'img', impact: 'serious', failureSummary: 'Add alt' }],
      },
    ]);

    const picked = pickMedianRun([first, second, third]);

    expect(picked.samples?.map((sample) => sample.violations)).toEqual([2, 2, 2]);
    expect(countViolationNodes(picked)).toBe(4);
    expect(picked.metrics.violations).toBe(4);
    expect(countViolationNodes({ violations: picked.violations })).toBe(picked.metrics.violations);

    const contrast = picked.violations.find((entry) => entry.id === 'color-contrast');
    expect(contrast?.nodes.map((node) => node.selector)).toEqual(['p.a', 'p.b', 'p.c']);
    expect(contrast?.impact).toBe('critical');
    expect(contrast?.nodes[0].snippet).toBe('<p class="a">');
    expect(contrast?.nodes[0].failureSummary).toBe('Fix A');

    const alt = picked.violations.find((entry) => entry.id === 'image-alt');
    expect(alt?.nodes).toHaveLength(1);
  });

  it('keeps the most severe impact when runs disagree about a node', () => {
    const picked = pickMedianRun([
      audit('a', { lcp: 1000, violations: 1 }, [
        {
          id: 'color-contrast',
          title: 'Contrast',
          impact: 'moderate',
          nodes: [{ selector: 'p', impact: 'moderate' }],
        },
      ]),
      audit('b', { lcp: 2000, violations: 1 }, [
        {
          id: 'color-contrast',
          title: 'Contrast',
          impact: 'critical',
          nodes: [{ selector: 'p', impact: 'critical' }],
        },
      ]),
    ]);

    expect(picked.violations[0].nodes[0].impact).toBe('critical');
    expect(picked.violations[0].impact).toBe('critical');
  });
});

describe('runAudit', () => {
  it('rejects an invalid run count before launching Chrome', async () => {
    await expect(runAudit('https://example.com/', { preset: 'mobile', runs: 0 })).rejects.toThrow(
      /runs must be a positive integer/,
    );
  });
});
