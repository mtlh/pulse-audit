import { describe, expect, it } from 'vitest';
import { checkNotes, checkView, checkViews, countChecks, findCheck } from '../src/checks.js';
import type { Check } from '../src/types.js';

function check(overrides: Partial<Check> = {}): Check {
  return {
    metric: 'lcp',
    label: 'LCP',
    value: 1500,
    formatted: '1.50s',
    format: 'ms',
    baseline: 1400,
    baselineFormatted: '1.40s',
    max: 2500,
    delta: 100,
    deltaPct: 7.142,
    status: 'pass',
    severity: 'error',
    reason: 'within budget (+100ms)',
    ...overrides,
  };
}

describe('checkView', () => {
  it('formats value, budget and delta for a compared check', () => {
    const view = checkView(check());
    expect(view.label).toBe('LCP');
    expect(view.value).toBe('1.50s');
    expect(view.budget).toBe('2.50s');
    expect(view.deltaText).toBe('+100ms');
    expect(view.deltaPctText).toBe('+7.1%');
    expect(view.deltaSummary).toBe('+100ms (+7.1%)');
    expect(view.hasDelta).toBe(true);
    expect(view.hasBaseline).toBe(true);
    expect(view.statusLabel).toBe('pass');
    expect(view.note).toBeUndefined();
  });

  it('keeps a missing budget or comparison quiet', () => {
    const view = checkView(
      check({ max: undefined, baseline: undefined, delta: undefined, deltaPct: undefined }),
    );
    expect(view.budget).toBe('—');
    expect(view.deltaSummary).toBe('—');
    expect(view.hasDelta).toBe(false);
    expect(view.hasBaseline).toBe(false);
  });

  it('uses uppercase labels for failures and warnings', () => {
    expect(checkView(check({ status: 'fail' })).statusLabel).toBe('FAIL');
    expect(checkView(check({ status: 'warn' })).statusLabel).toBe('WARN');
  });

  it('surfaces the explanation for a noteworthy pass', () => {
    const view = checkView(check({ reason: 'over max 2.50s but not a regression (-100ms)' }));
    expect(view.note).toBe('over max 2.50s but not a regression (-100ms)');
  });
});

describe('check collection helpers', () => {
  const checks = [
    check(),
    check({ metric: 'cls', label: 'CLS', status: 'fail', reason: 'over max' }),
    check({ metric: 'ttfb', label: 'TTFB', status: 'warn', reason: 'over max' }),
  ];

  it('counts every status', () => {
    expect(countChecks(checks)).toEqual({ failed: 1, warned: 1, passed: 1 });
    expect(countChecks([])).toEqual({ failed: 0, warned: 0, passed: 0 });
  });

  it('returns one view per check and finds a check by metric', () => {
    expect(checkViews(checks)).toHaveLength(3);
    expect(findCheck({ checks }, 'cls')?.status).toBe('fail');
    expect(findCheck({ checks }, 'js')).toBeUndefined();
  });

  it('only lists notes that explain something', () => {
    expect(checkNotes(checks)).toEqual([
      { label: 'CLS', reason: 'over max' },
      { label: 'TTFB', reason: 'over max' },
    ]);
  });
});
