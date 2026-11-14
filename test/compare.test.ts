import { describe, expect, it } from 'vitest';
import {
  compareResult,
  countNewViolations,
  countNewViolationsByImpact,
  countViolationNodes,
  filterIgnoredViolations,
} from '../src/compare.js';
import { defaultConfig } from '../src/config.js';
import type { A11yViolation, AuditMetrics, AuditResult, PulseConfig } from '../src/types.js';

const BASE_METRICS: AuditMetrics = {
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
  failedRequests: 0,
  thirdPartyBytes: 10_000,
  thirdPartyRequests: 5,
  longTasks: 3,
  violations: 0,
};

function result(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    url: 'https://example.com/',
    preset: 'mobile',
    runs: 3,
    capturedAt: '2026-01-01T00:00:00.000Z',
    lighthouseVersion: '12.0.0',
    metrics: { ...BASE_METRICS },
    heaviest: [],
    violations: [],
    ...overrides,
  };
}

function withMetrics(overrides: Partial<AuditMetrics>): AuditResult {
  return result({ metrics: { ...BASE_METRICS, ...overrides } });
}

function config(overrides: Partial<PulseConfig> = {}): PulseConfig {
  return { ...defaultConfig(['https://example.com/']), ...overrides };
}

function violation(
  id: string,
  impact: A11yViolation['impact'],
  nodes: A11yViolation['nodes'],
  title = id,
): A11yViolation {
  return { id, title, impact, nodes };
}

function check(checks: ReturnType<typeof compareResult>, metric: string) {
  const found = checks.find((candidate) => candidate.metric === metric);
  if (!found) throw new Error(`missing check ${metric}`);
  return found;
}

describe('compareResult', () => {
  it('passes when every metric is inside its budget', () => {
    const checks = compareResult(result(), result(), config());
    expect(checks.every((candidate) => candidate.status === 'pass')).toBe(true);
  });

  it('fails an absolute breach when there is no baseline', () => {
    const current = withMetrics({ lcp: 4000 });
    const lcp = check(compareResult(current, null, config()), 'lcp');
    expect(lcp.status).toBe('fail');
    expect(lcp.reason).toContain('over max');
  });

  it('does not fail an absolute breach that improved versus the baseline (ratchet)', () => {
    const baseline = withMetrics({ lcp: 4000 });
    const current = withMetrics({ lcp: 3900 });
    const lcp = check(compareResult(current, baseline, config()), 'lcp');
    expect(lcp.status).toBe('pass');
    expect(lcp.reason).toContain('not a regression');
  });

  it('fails an over-max metric when the baseline has no value for it', () => {
    // A v1 baseline predates metrics such as FCP. Without a baseline value the
    // ratchet cannot know the page improved, so it must not excuse the breach.
    const baseline = result({
      metrics: { ...BASE_METRICS, fcp: undefined as unknown as number },
    });
    const current = withMetrics({ fcp: 4000 });
    const fcp = check(compareResult(current, baseline, config()), 'fcp');

    expect(fcp.status).toBe('fail');
    expect(fcp.reason).toContain('over max');
    expect(fcp.reason).not.toContain('not a regression');
  });

  it('fails an over-max metric when the baseline value is zero', () => {
    const baseline = withMetrics({ js: 0 });
    const current = withMetrics({ js: 300_000 });
    const js = check(compareResult(current, baseline, config()), 'js');

    expect(js.status).toBe('fail');
    expect(js.reason).toContain('over max');
    expect(js.reason).not.toContain('not a regression');
  });

  it('explains a regression-only rule that has no usable baseline', () => {
    const regressionOnly = config({
      budgets: { ...config().budgets, lcp: { regression: 10 } },
    });
    const lcp = check(compareResult(withMetrics({ lcp: 1000 }), null, regressionOnly), 'lcp');

    expect(lcp.status).toBe('pass');
    expect(lcp.reason).toContain('no comparable baseline');
  });

  it('fails an over-max metric that got worse when the rule has no regression tolerance', () => {
    // A max-only rule cannot say "this increase is tolerable". Without a
    // regression percentage the ratchet must require an actual improvement.
    const maxOnly = config({ budgets: { ...config().budgets, lcp: { max: 2500 } } });
    const baseline = withMetrics({ lcp: 3900 });
    const current = withMetrics({ lcp: 4000 });
    const lcp = check(compareResult(current, baseline, maxOnly), 'lcp');

    expect(lcp.status).toBe('fail');
    expect(lcp.reason).toContain('over max');
  });

  it('ratchets an over-max metric that stayed flat against the baseline', () => {
    const maxOnly = config({ budgets: { ...config().budgets, lcp: { max: 2500 } } });
    const unchanged = withMetrics({ lcp: 4000 });
    const lcp = check(compareResult(unchanged, unchanged, maxOnly), 'lcp');

    expect(lcp.status).toBe('pass');
    expect(lcp.reason).toContain('not a regression');
  });

  it('fails an over-max metric that improved when strict is enabled', () => {
    const baseline = withMetrics({ lcp: 4000 });
    const current = withMetrics({ lcp: 3900 });
    const lcp = check(compareResult(current, baseline, config({ strict: true })), 'lcp');
    expect(lcp.status).toBe('fail');
    expect(lcp.reason).toContain('over max');
  });

  it('keeps a strict absolute breach a warning for warn-severity metrics', () => {
    const baseline = withMetrics({ tbt: 400 });
    const current = withMetrics({ tbt: 300 });
    const tbt = check(compareResult(current, baseline, config({ strict: true })), 'tbt');
    expect(tbt.status).toBe('warn');
  });

  it('fails a regression even when the absolute budget is met', () => {
    const baseline = withMetrics({ lcp: 1000 });
    const current = withMetrics({ lcp: 1300 });
    const lcp = check(compareResult(current, baseline, config()), 'lcp');
    expect(lcp.status).toBe('fail');
    expect(lcp.reason).toContain('regressed');
  });

  it('passes when failed requests stay at the inherited baseline', () => {
    const baseline = withMetrics({ failedRequests: 2 });
    const current = withMetrics({ failedRequests: 2 });
    const failed = check(compareResult(current, baseline, config()), 'failedRequests');

    expect(failed.label).toBe('Failed requests');
    expect(failed.format).toBe('count');
    expect(failed.severity).toBe('error');
    expect(failed.status).toBe('pass');
    expect(failed.reason).toContain('not a regression');
  });

  it('fails a failed request even when there is no baseline', () => {
    const current = withMetrics({ failedRequests: 1 });
    const failed = check(compareResult(current, null, config()), 'failedRequests');

    expect(failed.status).toBe('fail');
    expect(failed.reason).toContain('over max 0');
  });

  it('fails when a new failed request appears on top of inherited failures', () => {
    const baseline = withMetrics({ failedRequests: 2 });
    const current = withMetrics({ failedRequests: 3 });
    const failed = check(compareResult(current, baseline, config()), 'failedRequests');

    expect(failed.status).toBe('fail');
    expect(failed.value).toBe(3);
    expect(failed.baseline).toBe(2);
    expect(failed.reason).toContain('regressed');
  });

  it('fails when a metric is over max and regressed', () => {
    const baseline = withMetrics({ lcp: 2600 });
    const current = withMetrics({ lcp: 3000 });
    const lcp = check(compareResult(current, baseline, config()), 'lcp');
    expect(lcp.status).toBe('fail');
    expect(lcp.reason).toContain('over max');
    expect(lcp.reason).toContain('regressed');
  });

  it('downgrades a failure to a warning when severity is warn', () => {
    const baseline = withMetrics({ tbt: 100 });
    const current = withMetrics({ tbt: 400 });
    const tbt = check(compareResult(current, baseline, config()), 'tbt');
    expect(tbt.status).toBe('warn');
  });

  it('gates long tasks as a count with warning severity by default', () => {
    const baseline = withMetrics({ longTasks: 4 });
    const current = withMetrics({ longTasks: 20 });
    const longTasks = check(compareResult(current, baseline, config()), 'longTasks');

    expect(longTasks.label).toBe('Long tasks');
    expect(longTasks.format).toBe('count');
    expect(longTasks.value).toBe(20);
    expect(longTasks.max).toBe(10);
    expect(longTasks.status).toBe('warn');
    expect(longTasks.severity).toBe('warn');
    expect(longTasks.reason).toContain('over max 10');
  });

  it('passes long tasks inside both the max and the regression tolerance', () => {
    const longTasks = check(
      compareResult(withMetrics({ longTasks: 7 }), withMetrics({ longTasks: 6 }), config()),
      'longTasks',
    );
    expect(longTasks.status).toBe('pass');
  });

  it('warns when long tasks regress even under the absolute max', () => {
    const longTasks = check(
      compareResult(withMetrics({ longTasks: 7 }), withMetrics({ longTasks: 5 }), config()),
      'longTasks',
    );
    expect(longTasks.status).toBe('warn');
    expect(longTasks.reason).toContain('regressed +40.0%');
  });

  it('applies the long-task max when a stored baseline predates the metric', () => {
    const baseline = result({
      metrics: { ...BASE_METRICS, longTasks: undefined as unknown as number },
    });
    const longTasks = check(compareResult(withMetrics({ longTasks: 12 }), baseline, config()), 'longTasks');

    expect(longTasks.status).toBe('warn');
    expect(longTasks.reason).toContain('over max 10');
    expect(longTasks.reason).not.toContain('not a regression');
  });

  it('counts new a11y violation nodes against the baseline', () => {
    const baseline = result({
      violations: [violation('image-alt', 'serious', [{ selector: 'img.a' }])],
    });
    const current = result({
      violations: [violation('image-alt', 'serious', [{ selector: 'img.a' }, { selector: 'img.b' }])],
    });

    expect(countNewViolations(current, baseline)).toBe(1);
    const a11y = check(compareResult(current, baseline, config()), 'a11yNew');
    expect(a11y.value).toBe(1);
    expect(a11y.status).toBe('fail');
  });

  it('treats every violation as new when there is no baseline', () => {
    const current = result({
      violations: [violation('color-contrast', 'serious', [{ selector: 'p' }])],
    });
    expect(countNewViolations(current, null)).toBe(1);
  });

  it('does not gate new a11y violations before a baseline exists', () => {
    const current = result({
      violations: [violation('color-contrast', 'serious', [{ selector: 'p' }])],
    });
    const a11y = check(compareResult(current, null, config()), 'a11yNew');
    expect(a11y.value).toBe(0);
    expect(a11y.status).toBe('pass');
    expect(a11y.reason).toContain('no baseline');
  });

  it('emits one gate per configured impact bucket', () => {
    const baseline = result({
      violations: [violation('image-alt', 'serious', [{ selector: 'img.a' }])],
    });
    const current = result({
      violations: [
        violation('image-alt', 'serious', [
          { selector: 'img.a', impact: 'serious' },
          { selector: 'img.b', impact: 'serious' },
        ]),
      ],
    });

    expect(countNewViolationsByImpact(current, baseline, 'serious')).toBe(1);
    expect(countNewViolationsByImpact(current, baseline, 'critical')).toBe(0);

    const checks = compareResult(current, baseline, config());
    const serious = check(checks, 'a11yNew:serious');
    expect(serious.label).toBe('New serious a11y');
    expect(serious.value).toBe(1);
    expect(serious.status).toBe('fail');
    expect(serious.reason).toContain('max 0 new serious violations');

    const critical = check(checks, 'a11yNew:critical');
    expect(critical.label).toBe('New critical a11y');
    expect(critical.value).toBe(0);
    expect(critical.status).toBe('pass');
    expect(critical.reason).toBe('no new critical violations');
  });

  it('uses failureSummary to disambiguate two nodes with the same selector', () => {
    const baseline = result({
      violations: [
        violation('color-contrast', 'serious', [
          { selector: 'p', failureSummary: 'Fix contrast: foreground #aaa' },
        ]),
      ],
    });
    const current = result({
      violations: [
        violation('color-contrast', 'serious', [
          { selector: 'p', failureSummary: 'Fix contrast: font size' },
        ]),
      ],
    });

    expect(countNewViolations(current, baseline)).toBe(1);
  });

  it('ignores whitespace differences in failureSummary', () => {
    const baseline = result({
      violations: [
        violation('color-contrast', 'serious', [{ selector: 'p', failureSummary: 'Fix  the thing' }]),
      ],
    });
    const current = result({
      violations: [
        violation('color-contrast', 'serious', [{ selector: 'p', failureSummary: 'Fix the thing' }]),
      ],
    });

    expect(countNewViolations(current, baseline)).toBe(0);
  });

  it('matches a v1 baseline that has no failureSummary', () => {
    const v1Baseline = result({
      violations: [violation('image-alt', 'serious', [{ selector: 'img.hero' }])],
    });
    const current = result({
      violations: [
        violation('image-alt', 'serious', [{ selector: 'img.hero', failureSummary: 'Add an alt attribute' }]),
      ],
    });

    expect(countNewViolations(current, v1Baseline)).toBe(0);
    expect(countNewViolationsByImpact(current, v1Baseline, 'serious')).toBe(0);
  });

  it('matches a baseline with a failureSummary when the current node omits it', () => {
    const baseline = result({
      violations: [
        violation('image-alt', 'serious', [{ selector: 'img.hero', failureSummary: 'Add an alt attribute' }]),
      ],
    });
    const current = result({
      violations: [violation('image-alt', 'serious', [{ selector: 'img.hero' }])],
    });

    expect(countNewViolations(current, baseline)).toBe(0);
  });

  it('filters ignored rules out of total and new counts', () => {
    const baseline = result({
      violations: [violation('color-contrast', 'serious', [{ selector: 'p' }])],
    });
    const current = result({
      violations: [violation('color-contrast', 'serious', [{ selector: 'p' }, { selector: 'p.small' }])],
    });

    const filtered = filterIgnoredViolations(current, ['color-contrast']);
    expect(filtered).not.toBe(current);
    expect(filtered.violations).toEqual([]);
    expect(filtered.metrics.violations).toBe(0);

    const checks = compareResult(current, baseline, {
      ...config(),
      budgets: {
        ...config().budgets,
        a11y: { ...config().budgets.a11y, ignoreRules: ['color-contrast'] },
      },
    });
    expect(check(checks, 'a11yTotal').value).toBe(0);
    expect(check(checks, 'a11yNew').value).toBe(0);
    expect(check(checks, 'a11yNew:serious').value).toBe(0);
  });

  it('recalculates the violation count from the remaining nodes after filtering', () => {
    const current = result({
      metrics: { ...BASE_METRICS, violations: 3 },
      violations: [
        violation('color-contrast', 'serious', [{ selector: 'p' }, { selector: 'p.small' }]),
        violation('image-alt', 'serious', [{ selector: 'img' }]),
      ],
    });

    const filtered = filterIgnoredViolations(current, ['color-contrast']);
    expect(countViolationNodes(filtered)).toBe(1);
    expect(filtered.metrics.violations).toBe(1);
    expect(filtered.violations.map((entry) => entry.id)).toEqual(['image-alt']);
  });
});
