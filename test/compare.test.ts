import { describe, expect, it } from 'vitest';
import { compareResult, countNewViolations } from '../src/compare.js';
import { defaultConfig } from '../src/config.js';
import type { AuditResult, PulseConfig } from '../src/types.js';

function result(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    url: 'https://example.com/',
    preset: 'mobile',
    runs: 3,
    capturedAt: '2026-01-01T00:00:00.000Z',
    lighthouseVersion: '12.0.0',
    metrics: {
      lcp: 1000,
      cls: 0.01,
      tbt: 100,
      js: 100_000,
      images: 100_000,
      requests: 20,
      violations: 0,
    },
    heaviest: [],
    violations: [],
    ...overrides,
  };
}

function config(): PulseConfig {
  return defaultConfig(['https://example.com/']);
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
    const checks = compareResult(result({ metrics: { ...result().metrics, lcp: 4000 } }), null, config());
    const lcp = check(checks, 'lcp');
    expect(lcp.status).toBe('fail');
    expect(lcp.reason).toContain('over max');
  });

  it('does not fail an absolute breach that is not a regression', () => {
    const baseline = result({ metrics: { ...result().metrics, lcp: 4000 } });
    const current = result({ metrics: { ...result().metrics, lcp: 3900 } });
    const lcp = check(compareResult(current, baseline, config()), 'lcp');
    expect(lcp.status).toBe('pass');
    expect(lcp.reason).toContain('not a regression');
  });

  it('fails a regression even when the absolute budget is met', () => {
    const baseline = result({ metrics: { ...result().metrics, lcp: 1000 } });
    const current = result({ metrics: { ...result().metrics, lcp: 1300 } });
    const lcp = check(compareResult(current, baseline, config()), 'lcp');
    expect(lcp.status).toBe('fail');
    expect(lcp.reason).toContain('regressed');
  });

  it('fails when a metric is over max and regressed', () => {
    const baseline = result({ metrics: { ...result().metrics, lcp: 2600 } });
    const current = result({ metrics: { ...result().metrics, lcp: 3000 } });
    const lcp = check(compareResult(current, baseline, config()), 'lcp');
    expect(lcp.status).toBe('fail');
    expect(lcp.reason).toContain('over max');
    expect(lcp.reason).toContain('regressed');
  });

  it('downgrades a failure to a warning when severity is warn', () => {
    const baseline = result({ metrics: { ...result().metrics, tbt: 100 } });
    const current = result({ metrics: { ...result().metrics, tbt: 400 } });
    const tbt = check(compareResult(current, baseline, config()), 'tbt');
    expect(tbt.status).toBe('warn');
  });

  it('counts new a11y violation nodes against the baseline', () => {
    const baseline = result({
      violations: [{ id: 'image-alt', title: 'Images must have alt', impact: 'serious', nodes: [{ selector: 'img.a' }] }],
    });
    const current = result({
      violations: [
        {
          id: 'image-alt',
          title: 'Images must have alt',
          impact: 'serious',
          nodes: [{ selector: 'img.a' }, { selector: 'img.b' }],
        },
      ],
    });

    expect(countNewViolations(current, baseline)).toBe(1);
    const a11y = check(compareResult(current, baseline, config()), 'a11yNew');
    expect(a11y.value).toBe(1);
    expect(a11y.status).toBe('fail');
  });

  it('treats every violation as new when there is no baseline', () => {
    const current = result({
      violations: [{ id: 'color-contrast', title: 'Contrast', impact: 'serious', nodes: [{ selector: 'p' }] }],
    });
    expect(countNewViolations(current, null)).toBe(1);
  });

  it('does not gate new a11y violations before a baseline exists', () => {
    const current = result({
      violations: [{ id: 'color-contrast', title: 'Contrast', impact: 'serious', nodes: [{ selector: 'p' }] }],
    });
    const a11y = check(compareResult(current, null, config()), 'a11yNew');
    expect(a11y.value).toBe(0);
    expect(a11y.status).toBe('pass');
    expect(a11y.reason).toContain('no baseline');
  });
});
