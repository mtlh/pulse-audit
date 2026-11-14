import { describe, expect, it } from 'vitest';
import { renderHtml } from '../src/reporters/html.js';
import type {
  ApiReportEntry,
  ApiResult,
  AuditMetrics,
  AuditResult,
  Check,
  PulseReport,
  ReportEntry,
} from '../src/types.js';

const evil = '<script>window.pwned = 1</script><img src=x onerror="window.pwned = 1">';

const BASE_METRICS: AuditMetrics = {
  lcp: 1545,
  cls: 0.015,
  tbt: 120,
  fcp: 900,
  ttfb: 200,
  js: 50_000,
  css: 10_000,
  fonts: 20_000,
  images: 30_000,
  total: 120_000,
  requests: 12,
  failedRequests: 0,
  thirdPartyBytes: 5120,
  thirdPartyRequests: 2,
  longTasks: 2,
  thirdPartyMainThread: 840,
  violations: 3,
};

function metrics(overrides: Partial<AuditMetrics> = {}): AuditMetrics {
  return { ...BASE_METRICS, ...overrides };
}

function check(overrides: Partial<Check>): Check {
  return {
    metric: 'lcp',
    label: 'LCP',
    value: 1545,
    formatted: '1.55s',
    format: 'ms',
    max: 2500,
    status: 'pass',
    severity: 'error',
    reason: 'within budget',
    ...overrides,
  };
}

function audit(overrides: Partial<AuditResult> = {}): AuditResult {
  const samples = [metrics({ lcp: 1480, cls: 0.01 }), metrics({ lcp: 1610, cls: 0.02 })];

  return {
    url: 'https://example.com/',
    preset: 'mobile',
    runs: 3,
    capturedAt: '2026-11-02T00:00:00.000Z',
    metrics: metrics(),
    lcpElement: { selector: evil, snippet: evil },
    heaviest: [
      { url: `https://example.com/${evil}`, resourceType: 'Script', bytes: 1000, thirdParty: false },
      { url: 'https://example.com/half.js', resourceType: 'Script', bytes: 500, thirdParty: false },
    ],
    thirdPartyHeaviest: [
      {
        url: `https://cdn.example.com/${evil}`,
        resourceType: 'Script',
        bytes: 3072,
        thirdParty: true,
      },
      {
        url: 'https://fonts.example.com/font.woff2',
        resourceType: 'Font',
        bytes: 2048,
        thirdParty: true,
      },
    ],
    longTaskDetails: [
      { url: `https://example.com/${evil}`, startTime: 900, duration: 320 },
      { startTime: 1200, duration: 140 },
    ],
    thirdPartyCpu: [
      { entity: 'Google Analytics', mainThreadTime: 420, transferSize: 5120 },
      { entity: 'cdn.example.com', mainThreadTime: 210, transferSize: 3072 },
      { entity: evil, mainThreadTime: 105, transferSize: 1024 },
    ],
    violations: [
      {
        id: 'color-contrast',
        title: evil,
        impact: 'serious',
        nodes: [
          { selector: evil, snippet: evil, impact: 'serious' },
          { selector: '.faint', impact: 'critical' },
        ],
      },
      {
        id: 'image-alt',
        title: 'Images need alt text',
        impact: 'critical',
        nodes: [{ selector: 'img', impact: 'critical' }],
      },
    ],
    samples,
    ...overrides,
  };
}

function entry(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return {
    url: 'https://example.com/',
    audit: audit(),
    baseline: null,
    checks: [
      check({}),
      check({
        metric: 'cls',
        label: 'CLS',
        value: 0.015,
        formatted: '0.015',
        format: 'score',
        max: 0.05,
      }),
      check({
        metric: 'a11yNew',
        label: 'New a11y violations',
        value: 3,
        formatted: '3',
        format: 'count',
        max: 0,
        status: 'fail',
        reason: 'max 0 new violations',
      }),
      check({
        metric: 'fcp',
        label: 'FCP',
        value: 1900,
        formatted: '1.90s',
        max: 1000,
        status: 'pass',
        reason: 'over max 1.00s but not a regression (-124ms)',
      }),
    ],
    ...overrides,
  };
}

function apiResult(overrides: Partial<ApiResult> = {}): ApiResult {
  return {
    url: 'https://api.example.com/items',
    method: 'GET',
    runs: 2,
    capturedAt: '2026-11-02T00:00:00.000Z',
    metrics: { ttfb: 120, duration: 300, bytes: 2048, status: 200 },
    samples: [
      { ttfb: 100, duration: 280, bytes: 2048, status: 200 },
      { ttfb: 140, duration: 320, bytes: 2048, status: 200 },
    ],
    ...overrides,
  };
}

function apiEntry(overrides: Partial<ApiReportEntry> = {}): ApiReportEntry {
  return {
    url: 'https://api.example.com/items',
    method: 'GET',
    result: apiResult(),
    baseline: null,
    checks: [
      check({ metric: 'ttfb', label: 'TTFB', value: 120, formatted: '120ms' }),
      check({ metric: 'duration', label: 'Duration', value: 300, formatted: '300ms' }),
      check({
        metric: 'status',
        label: 'HTTP status',
        value: 200,
        formatted: '200',
        max: undefined,
        format: 'count',
        reason: 'within expected status',
      }),
    ],
    ...overrides,
  };
}

function report(overrides: Partial<PulseReport> = {}): PulseReport {
  return {
    version: '3',
    generatedAt: '2026-11-02T00:00:00.000Z',
    preset: 'mobile',
    presets: ['mobile'],
    runs: 3,
    results: [entry()],
    failed: 1,
    warned: 0,
    passed: 3,
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

  it('renders a run variance card with min, median, max and spread', () => {
    const html = renderHtml(report());

    expect(html).toContain('Run variance');
    expect(html).toContain('<th>Min</th><th>Median</th><th>Max</th><th>Spread</th>');
    expect(html).toContain('1.48s');
    expect(html).toContain('1.55s');
    expect(html).toContain('1.61s');
    expect(html).toContain('0.010');
    expect(html).toContain('0.015');
    expect(html).toContain('0.020');
    expect(html).toContain('+8.4%');
    expect(html).toContain('+66.7%');
    // The measured run count wins over the (different) gate run count.
    expect(html).toContain('<span class="muted">2 runs</span>');
  });

  it('omits the run variance card when only one sample exists', () => {
    const single = audit({ samples: [metrics()] });
    const html = renderHtml(report({ results: [entry({ audit: single })] }));

    expect(html).not.toContain('Run variance');
  });

  it('renders a third-party request card with count and bytes', () => {
    const html = renderHtml(report());

    expect(html).toContain('Third-party requests');
    expect(html).toContain('2 requests · 5.0 KB');
    expect(html).toContain('cdn.example.com');
    expect(html).toContain('fonts.example.com');
  });

  it('renders a muted note when third-party bytes exist without request detail', () => {
    const withoutDetail = audit({ thirdPartyHeaviest: [] });
    const html = renderHtml(report({ results: [entry({ audit: withoutDetail })] }));

    expect(html).toContain('Third-party requests');
    expect(html).toContain('5.0 KB from third-party origins; per-request detail was not captured.');
  });

  it('renders a failed requests card with status, url and resource type', () => {
    const withFailures = audit({
      metrics: metrics({ failedRequests: 3 }),
      failedRequestDetails: [
        {
          url: `https://example.com/${evil}`,
          resourceType: 'Image',
          bytes: 10,
          thirdParty: false,
          statusCode: 404,
          failed: true,
        },
        {
          url: 'https://api.example.com/data',
          resourceType: 'Fetch',
          bytes: 0,
          thirdParty: false,
          statusCode: 500,
          failed: true,
        },
        {
          url: 'https://cdn.example.net/aborted.js',
          resourceType: 'Script',
          bytes: 0,
          thirdParty: true,
          failed: true,
        },
      ],
    });
    const html = renderHtml(report({ results: [entry({ audit: withFailures })] }));

    expect(html).toContain('Failed requests');
    expect(html).toContain('3 requests');
    expect(html).toContain('404');
    expect(html).toContain('api.example.com/data');
    expect(html).toContain('Fetch');
    expect(html).toContain('aborted');
    expect(html).not.toContain('<script>window.pwned');
  });

  it('omits the failed requests card when nothing failed', () => {
    const html = renderHtml(report());

    expect(html).not.toContain('Failed requests');
  });

  it('notes when failed requests exist without per-request detail', () => {
    const withCountOnly = audit({
      metrics: metrics({ failedRequests: 2 }),
      failedRequestDetails: [],
    });
    const html = renderHtml(report({ results: [entry({ audit: withCountOnly })] }));

    expect(html).toContain('Failed requests');
    expect(html).toContain('2 requests');
    expect(html).toContain('Per-request detail was not captured.');
  });

  it('shows third-party main-thread CPU detail in the same card', () => {
    const html = renderHtml(report());

    expect(html).toContain('Main-thread CPU time');
    expect(html).toContain('840ms');
    expect(html).toContain('Google Analytics');
    expect(html).toContain('420ms · 5.0 KB');
    expect(html).toContain('cdn.example.com');
    expect(html).toContain('210ms · 3.0 KB');
  });

  it('shows the CPU card when third-party request detail is missing', () => {
    const cpuOnly = audit({ thirdPartyHeaviest: [], metrics: metrics({ thirdPartyBytes: 0 }) });
    const html = renderHtml(report({ results: [entry({ audit: cpuOnly })] }));

    expect(html).toContain('Third-party requests');
    expect(html).toContain('Main-thread CPU time');
    expect(html).not.toContain('per-request detail was not captured');
  });

  it('omits the CPU section when no third-party CPU detail was captured', () => {
    const withoutCpu = audit({ thirdPartyCpu: [] });
    const html = renderHtml(report({ results: [entry({ audit: withoutCpu })] }));

    expect(html).toContain('Third-party requests');
    expect(html).not.toContain('Main-thread CPU time');
  });

  it('shows accessibility impact counts in the card heading', () => {
    const html = renderHtml(report());

    expect(html).toContain('3 nodes · 2 critical · 1 serious');
  });

  it('renders a long tasks card with duration and attributed URL', () => {
    const html = renderHtml(report());

    expect(html).toContain('Long tasks <span class="muted">2 tasks &ge; 50ms</span>');
    expect(html).toContain('320ms');
    expect(html).toContain('140ms');
    expect(html).toContain('Unattributed');
    expect(html).toContain('cdn.example.com'); // unaffected request card
    expect(html).not.toContain('<script>window.pwned');
  });

  it('omits the long tasks card when the page has none', () => {
    const none = audit({ metrics: metrics({ longTasks: 0 }), longTaskDetails: undefined });
    const html = renderHtml(report({ results: [entry({ audit: none })] }));

    expect(html).not.toContain('Long tasks');
  });

  it('explains a long-task count with no per-task detail', () => {
    const countOnly = audit({ metrics: metrics({ longTasks: 3 }), longTaskDetails: [] });
    const html = renderHtml(report({ results: [entry({ audit: countOnly })] }));

    expect(html).toContain('3 tasks of 50ms or more');
  });

  it('counts unique nodes the same way the gate does', () => {
    const duplicate = audit({
      violations: [
        {
          id: 'color-contrast',
          title: 'Contrast',
          impact: 'serious',
          nodes: [
            { selector: 'p', impact: 'serious' },
            { selector: 'p', impact: 'serious' },
          ],
        },
      ],
    });
    const html = renderHtml(report({ results: [entry({ audit: duplicate })] }));

    expect(html).toContain('1 node · 1 serious');
    expect(html).not.toContain('2 nodes');
  });

  it('adds a cross-URL summary with anchors for multiple URLs', () => {
    const second = entry({
      url: 'https://second.example/',
      audit: audit({ url: 'https://second.example/', preset: 'desktop' }),
    });
    const html = renderHtml(
      report({
        presets: ['mobile', 'desktop'],
        results: [entry(), second],
        failed: 2,
        passed: 6,
      }),
    );

    expect(html).toContain('<h3>Cross-URL summary</h3>');
    expect(html).toContain('href="#url-1"');
    expect(html).toContain('href="#url-2"');
    expect(html).toContain('id="url-1"');
    expect(html).toContain('id="url-2"');
    expect(html).toContain('<th>URL</th><th>Preset</th>');
  });

  it('omits the cross-URL summary for a single URL', () => {
    const html = renderHtml(report());

    expect(html).not.toContain('href="#url-1"');
    expect(html).not.toContain('<h3>Cross-URL summary</h3>');
  });

  it('shows ignored a11y rules instead of silently hiding them', () => {
    const base = report();
    const entry = {
      ...base.results[0],
      ignoredRules: ['color-contrast'],
      ignoredViolations: 2,
    };
    const html = renderHtml({ ...base, results: [entry] });

    expect(html).toContain('Ignored 2 nodes');
    expect(html).toContain('color-contrast');
    expect(html).toContain('Suppressed findings are not gated');
  });

  it('renders API timings in their own section with method and status', () => {
    const html = renderHtml(
      report({
        results: [entry()],
        apiResults: [
          apiEntry(),
          apiEntry({
            url: `https://api.example.com/${evil}`,
            method: 'POST',
            checks: [
              check({
                metric: 'status',
                label: 'HTTP status',
                value: 500,
                formatted: '500',
                format: 'count',
                status: 'fail',
              }),
            ],
          }),
        ],
      }),
    );

    expect(html).toContain('API timings');
    expect(html).toContain('UI pages');
    expect(html).toContain('<span class="method">GET</span>');
    expect(html).toContain('<span class="method">POST</span>');
    expect(html).toContain('API summary');
    expect(html).toContain('href="#api-1"');
    expect(html).toContain('id="api-2"');
    expect(html).not.toContain('<script>window.pwned');
  });

  it('labels an API-only report without inventing a UI section', () => {
    const withApiOnly = renderHtml(report({ results: [], apiResults: [apiEntry()] }));
    expect(withApiOnly).toContain('API timings');
    expect(withApiOnly).not.toContain('UI pages');
    expect(withApiOnly).toContain('HTTP status');

    const withUiOnly = renderHtml(report());
    expect(withUiOnly).not.toContain('API timings');
    expect(withUiOnly).not.toContain('UI pages');
  });

  it('renders API run variance when samples differ', () => {
    const html = renderHtml(report({ results: [], apiResults: [apiEntry()] }));

    expect(html).toContain('Run variance');
    expect(html).toContain('100ms');
    expect(html).toContain('140ms');
  });

  it('stays self-contained and under the report budget', () => {
    const html = renderHtml(
      report({
        results: [entry(), entry({ url: 'https://second.example/' })],
      }),
    );

    expect(html.length).toBeLessThan(100_000);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<link\b[^>]+rel=["']stylesheet/i);
    expect(html).not.toMatch(/@import\s+url/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
  });
});
