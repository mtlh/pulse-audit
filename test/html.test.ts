import { describe, expect, it } from 'vitest';
import { renderHtml } from '../src/reporters/html.js';
import type { Check, PulseReport } from '../src/types.js';

const evil = '<script>window.pwned = 1</script><img src=x onerror="window.pwned = 1">';

function check(overrides: Partial<Check>): Check {
  return {
    metric: 'lcp',
    label: 'LCP',
    value: 1500,
    formatted: '1.50s',
    format: 'ms',
    max: 2500,
    status: 'pass',
    severity: 'error',
    reason: 'within budget',
    ...overrides,
  };
}

function report(overrides: Partial<PulseReport> = {}): PulseReport {
  return {
    version: '1',
    generatedAt: '2026-11-02T00:00:00.000Z',
    preset: 'mobile',
    runs: 1,
    results: [
      {
        url: 'https://example.com/',
        audit: {
          url: 'https://example.com/',
          preset: 'mobile',
          runs: 1,
          capturedAt: '2026-11-02T00:00:00.000Z',
          metrics: { lcp: 1500, cls: 0.01, tbt: 50, js: 1000, images: 2000, requests: 2, violations: 1 },
          lcpElement: { selector: evil, snippet: evil },
          heaviest: [
            { url: `https://example.com/${evil}`, resourceType: 'Script', bytes: 1000, thirdParty: false },
            { url: 'https://example.com/half.js', resourceType: 'Script', bytes: 500, thirdParty: false },
          ],
          violations: [{ id: 'color-contrast', title: evil, impact: 'serious', nodes: [{ selector: evil, snippet: evil }] }],
        },
        baseline: null,
        checks: [
          check({}),
          check({
            metric: 'a11yNew',
            label: 'New a11y violations',
            value: 1,
            formatted: '1',
            format: 'count',
            max: 0,
            status: 'fail',
            reason: 'max 0 new violations',
          }),
          check({
            label: 'LCP',
            value: 1500,
            formatted: '1.50s',
            max: 1000,
            status: 'pass',
            reason: 'over max 1.00s but not a regression (-124ms)',
          }),
        ],
      },
    ],
    failed: 1,
    warned: 0,
    passed: 1,
    ...overrides,
  };
}

describe('renderHtml', () => {
  it('escapes every page-derived value', () => {
    const html = renderHtml(report());

    expect(html).not.toContain('<script>window.pwned');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;window.pwned = 1&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;window.pwned = 1&quot;&gt;');
  });

  it('renders a pill per check with the right status class', () => {
    const html = renderHtml(report());

    expect(html).toContain('<span class="pill pass">pass</span>');
    expect(html).toContain('<span class="pill fail">fail</span>');
  });

  it('shows why a passing check was still notable', () => {
    const html = renderHtml(report());

    expect(html).toContain('over max 1.00s but not a regression (-124ms)');
    expect(html).toContain('max 0 new violations');
    expect(html).not.toContain('within budget');
  });

  it('scales request bars against the heaviest request', () => {
    const html = renderHtml(report());

    expect(html).toContain('style="width:100%"');
    expect(html).toContain('style="width:50%"');
  });

  it('stays self-contained and under the report budget', () => {
    const html = renderHtml(report());

    expect(html.length).toBeLessThan(100_000);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<link\b[^>]+rel=["']stylesheet/i);
    expect(html).not.toMatch(/@import\s+url/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
  });
});
