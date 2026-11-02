import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  formatBytes,
  formatDelta,
  formatPercent,
  formatRange,
  formatValue,
  noteworthyReason,
} from '../src/format.js';
import type { Check } from '../src/types.js';

function check(overrides: Partial<Check> = {}): Check {
  return {
    metric: 'lcp',
    label: 'LCP',
    value: 1500,
    formatted: '1.50s',
    format: 'ms',
    status: 'pass',
    severity: 'error',
    reason: 'within budget',
    ...overrides,
  };
}

describe('formatValue', () => {
  it('formats each value kind', () => {
    expect(formatValue(999, 'ms')).toBe('999ms');
    expect(formatValue(1500, 'ms')).toBe('1.50s');
    expect(formatValue(0.015, 'score')).toBe('0.015');
    expect(formatValue(1536, 'bytes')).toBe('1.5 KB');
    expect(formatValue(12.4, 'count')).toBe('12');
  });

  it('renders a non-finite value as an em dash', () => {
    expect(formatValue(Number.NaN, 'ms')).toBe('—');
  });
});

describe('formatBytes', () => {
  it('uses powers of 1024 and never renders a negative size', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(-1024)).toBe('0 B');
  });
});

describe('formatDelta', () => {
  it('keeps the sign for every format, including byte improvements', () => {
    expect(formatDelta(120, 'ms')).toBe('+120ms');
    expect(formatDelta(-120, 'ms')).toBe('-120ms');
    expect(formatDelta(1500, 'ms')).toBe('+1.50s');
    expect(formatDelta(-1500, 'ms')).toBe('-1.50s');

    // formatBytes only renders positive values; a shrinking payload must still
    // read as a decrease in every report.
    expect(formatDelta(51200, 'bytes')).toBe('+50.0 KB');
    expect(formatDelta(-51200, 'bytes')).toBe('-50.0 KB');

    expect(formatDelta(0.005, 'score')).toBe('+0.005');
    expect(formatDelta(-0.005, 'score')).toBe('-0.005');
    expect(formatDelta(3, 'count')).toBe('+3');
    expect(formatDelta(-3, 'count')).toBe('-3');
  });

  it('renders an unknown or non-finite delta as an em dash', () => {
    expect(formatDelta(undefined, 'ms')).toBe('—');
    expect(formatDelta(Number.NaN, 'bytes')).toBe('—');
  });
});

describe('formatPercent', () => {
  it('adds a sign only when positive', () => {
    expect(formatPercent(12.34)).toBe('+12.3%');
    expect(formatPercent(-12.34)).toBe('-12.3%');
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(undefined)).toBe('—');
  });
});

describe('formatRange', () => {
  it('collapses a shared unit', () => {
    expect(formatRange(1480, 1610, 'ms')).toBe('1.48–1.61s');
    expect(formatRange(512, 2048, 'bytes')).toBe('512 B–2.0 KB');
  });

  it('keeps both units when they differ', () => {
    expect(formatRange(0, 1500, 'ms')).toBe('0ms–1.50s');
  });

  it('renders scores and counts without unit handling', () => {
    expect(formatRange(0.01, 0.02, 'score')).toBe('0.010–0.020');
    expect(formatRange(1, 3, 'count')).toBe('1–3');
  });
});

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('noteworthyReason', () => {
  it('stays quiet for routine passes', () => {
    expect(noteworthyReason(check())).toBeUndefined();
    expect(noteworthyReason(check({ reason: 'within budget (+10ms)' }))).toBeUndefined();
    expect(noteworthyReason(check({ metric: 'a11yNew', reason: 'no new violations' }))).toBeUndefined();
  });

  it('explains failures, warnings and the ratchet', () => {
    expect(noteworthyReason(check({ status: 'fail', reason: 'over max 2.50s' }))).toBe('over max 2.50s');
    expect(noteworthyReason(check({ status: 'warn', reason: 'over max 200ms' }))).toBe('over max 200ms');
    expect(noteworthyReason(check({ reason: 'over max 2.50s but not a regression (-100ms)' }))).toBe(
      'over max 2.50s but not a regression (-100ms)',
    );
  });
});
