import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import {
  REPORT_VERSION,
  buildReport,
  reportEntry,
  type ApiReportInput,
  type ReportInput,
} from '../src/report.js';
import { printReport } from '../src/reporters/terminal.js';
import type {
  A11yImpact,
  A11yViolation,
  ApiResult,
  AuditMetrics,
  AuditResult,
  PulseConfig,
} from '../src/types.js';

const METRICS: AuditMetrics = {
  lcp: 1000,
  cls: 0.01,
  tbt: 100,
  fcp: 1200,
  ttfb: 300,
  js: 100_000,
  css: 20_000,
  fonts: 50_000,
  images: 100_000,
  total: 500_000,
  requests: 20,
  thirdPartyBytes: 10_000,
  thirdPartyRequests: 5,
  longTasks: 2,
  violations: 0,
};

function metrics(overrides: Partial<AuditMetrics> = {}): AuditMetrics {
  return { ...METRICS, ...overrides };
}

function result(overrides: Partial<AuditResult> = {}): AuditResult {
  const measured = metrics();
  return {
    url: 'https://example.com/',
    preset: 'mobile',
    runs: 3,
    capturedAt: '2026-11-02T00:00:00.000Z',
    lighthouseVersion: '12.0.0',
    metrics: measured,
    heaviest: [],
    violations: [],
    samples: [measured, metrics()],
    ...overrides,
  };
}

function config(overrides: Partial<PulseConfig> = {}): PulseConfig {
  return { ...defaultConfig(['https://example.com/']), ...overrides };
}

function violation(id: string, impact: A11yImpact, selectors: string[]): A11yViolation {
  return {
    id,
    title: id,
    impact,
    nodes: selectors.map((selector) => ({ selector, impact })),
  };
}

function input(
  audit: AuditResult,
  cfg: PulseConfig = config(),
  baseline: AuditResult | null = null,
): ReportInput {
  return { result: audit, baseline, config: cfg };
}

function apiResult(overrides: Partial<ApiResult> = {}): ApiResult {
  return {
    url: 'https://api.example.com/items',
    method: 'GET',
    runs: 3,
    capturedAt: '2026-11-02T00:00:00.000Z',
    metrics: { ttfb: 120, duration: 300, bytes: 2048, status: 200 },
    ...overrides,
  };
}

function apiInput(
  result: ApiResult,
  baseline: ApiResult | null = null,
  overrides: Partial<ApiReportInput> = {},
): ApiReportInput {
  return {
    result,
    baseline,
    budgets: { ttfb: { max: 200 }, duration: { max: 500 } },
    ...overrides,
  };
}

function checkFor(checks: ReturnType<typeof reportEntry>['checks'], metric: string) {
  const found = checks.find((check) => check.metric === metric);
  if (!found) throw new Error(`missing check ${metric}`);
  return found;
}

describe('buildReport', () => {
  it('exports the report version', () => {
    expect(REPORT_VERSION).toBe('3');
  });

  it('removes ignored axe rules from the audit and the a11y checks', () => {
    const current = result({
      metrics: metrics({ violations: 3 }),
      violations: [
        violation('color-contrast', 'serious', ['.a', '.b']),
        violation('image-alt', 'critical', ['img']),
      ],
    });
    const cfg = config({
      budgets: {
        ...config().budgets,
        a11y: { maxViolations: 5, maxNew: 0, ignoreRules: ['color-contrast'] },
      },
    });

    const entry = reportEntry(input(current, cfg));

    expect(entry.audit.violations.map((item) => item.id)).toEqual(['image-alt']);
    expect(entry.audit.metrics.violations).toBe(1);
    expect(entry.ignoredRules).toEqual(['color-contrast']);
    expect(entry.ignoredViolations).toBe(2);
    expect(entry.baseline).toBeNull();
    expect(checkFor(entry.checks, 'a11yTotal').value).toBe(1);
    expect(entry.checks.some((check) => check.value === 3 && check.metric === 'a11yTotal')).toBe(false);
    // The source audit is not mutated.
    expect(current.violations).toHaveLength(2);
  });

  it('aggregates failed, warned and passed checks across entries', () => {
    const ok = result({ url: 'https://ok.example/' });
    const bad = result({ url: 'https://bad.example/', metrics: metrics({ lcp: 4000 }) });

    const report = buildReport([input(ok), input(bad)]);

    expect(report.failed).toBe(1);
    expect(report.warned).toBe(0);
    const checks = report.results.flatMap((entry) => entry.checks);
    expect(report.failed + report.warned + report.passed).toBe(checks.length);
    expect(report.results).toHaveLength(2);
  });

  it('keeps presets unique in encounter order and uses the max run count', () => {
    const mobile1 = result({ url: 'https://one.example/', preset: 'mobile', runs: 2 });
    const desktop = result({ url: 'https://two.example/', preset: 'desktop', runs: 5 });
    const mobile2 = result({ url: 'https://three.example/', preset: 'mobile', runs: 4 });

    const report = buildReport([input(mobile1), input(desktop), input(mobile2)]);

    expect(report.presets).toEqual(['mobile', 'desktop']);
    expect(report.preset).toBe('mobile');
    expect(report.runs).toBe(5);
  });

  it('respects per-entry configs', () => {
    const strictPage = result({ url: 'https://strict.example/', metrics: metrics({ lcp: 1500 }) });
    const loosePage = result({ url: 'https://loose.example/', metrics: metrics({ lcp: 1500 }) });

    const strictConfig = config({
      urls: ['https://strict.example/'],
      budgets: { ...config().budgets, lcp: { max: 1000 } },
    });
    const looseConfig = config({
      urls: ['https://loose.example/'],
      budgets: { ...config().budgets, lcp: { max: 2000 } },
    });

    const report = buildReport([input(strictPage, strictConfig), input(loosePage, looseConfig)]);

    expect(checkFor(report.results[0].checks, 'lcp').status).toBe('fail');
    expect(checkFor(report.results[1].checks, 'lcp').status).toBe('pass');
    expect(report.failed).toBe(1);
  });

  it('applies ignored rules to the baseline before comparing', () => {
    const current = result({
      violations: [
        violation('color-contrast', 'serious', ['.new']),
        violation('image-alt', 'critical', ['img']),
      ],
      metrics: metrics({ violations: 2 }),
    });
    const baseline = result({
      violations: [violation('color-contrast', 'serious', ['.old'])],
      metrics: metrics({ violations: 1 }),
    });
    const cfg = config({
      budgets: {
        ...config().budgets,
        a11y: { maxNew: 5, ignoreRules: ['color-contrast'] },
      },
    });

    const entry = reportEntry(input(current, cfg, baseline));

    expect(entry.baseline?.violations).toEqual([]);
    expect(checkFor(entry.checks, 'a11yNew').value).toBe(1);
  });

  it('adds API results as a separate list and includes their checks in the totals', () => {
    const ok = apiResult();
    const slow = apiResult({
      url: 'https://api.example.com/slow',
      metrics: { ttfb: 500, duration: 400, bytes: 2048, status: 200 },
    });

    const report = buildReport([input(result())], [apiInput(ok), apiInput(slow)]);

    expect(report.apiResults).toHaveLength(2);
    expect(report.results).toHaveLength(1);
    expect(report.apiResults?.[0]?.checks.find((check) => check.metric === 'status')?.status).toBe('pass');
    expect(report.apiResults?.[1]?.checks.find((check) => check.metric === 'ttfb')?.status).toBe('fail');
    expect(report.failed).toBe(1);
    expect(report.passed).toBeGreaterThan(0);
    expect(report.passed + report.warned + report.failed).toBe(
      [
        ...report.results.flatMap((entry) => entry.checks),
        ...report.apiResults!.flatMap((entry) => entry.checks),
      ].length,
    );
  });

  it('uses API baseline deltas per metric', () => {
    const baseline = apiResult({ metrics: { ttfb: 100, duration: 200, bytes: 1024, status: 200 } });
    const current = apiResult({ metrics: { ttfb: 130, duration: 210, bytes: 2048, status: 200 } });

    const report = buildReport([], [apiInput(current, baseline)]);
    const checks = report.apiResults?.[0]?.checks ?? [];

    expect(checks.find((check) => check.metric === 'ttfb')?.delta).toBe(30);
    expect(checks.find((check) => check.metric === 'ttfb')?.baseline).toBe(100);
    expect(checks.find((check) => check.metric === 'status')?.status).toBe('pass');
  });

  it('allows an API-only report without pretending it has UI results', () => {
    const report = buildReport([], [apiInput(apiResult({ runs: 2 }))]);

    expect(report.results).toEqual([]);
    expect(report.apiResults).toHaveLength(1);
    expect(report.runs).toBe(2);
  });
});

describe('printReport', () => {
  it('prints one compact spread line per entry', () => {
    const measured = result({
      metrics: metrics({ lcp: 1545, cls: 0.015 }),
      samples: [metrics({ lcp: 1480, cls: 0.01 }), metrics({ lcp: 1610, cls: 0.02 })],
    });
    const report = buildReport([input(measured)]);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    try {
      printReport(report);
    } finally {
      spy.mockRestore();
    }

    const spreadLines = lines.filter((line) => line.includes('spread'));
    expect(spreadLines).toHaveLength(1);
    expect(spreadLines[0]).toContain('LCP 1.48–1.61s');
    expect(spreadLines[0]).toContain('CLS 0.010–0.020');
  });
});
