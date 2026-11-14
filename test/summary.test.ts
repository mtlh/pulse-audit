import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdown, upsertSummary } from '../src/reporters/summary.js';
import type { ApiReportEntry, AuditMetrics, Check, PulseReport } from '../src/types.js';

const METRICS: AuditMetrics = {
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
  thirdPartyBytes: 0,
  thirdPartyRequests: 0,
  longTasks: 0,
  thirdPartyMainThread: 0,
  consoleErrors: 0,
  violations: 0,
};

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

function report(overrides: Partial<PulseReport> = {}): PulseReport {
  return {
    version: '3',
    generatedAt: '2026-11-02T00:00:00.000Z',
    preset: 'mobile',
    presets: ['mobile'],
    runs: 3,
    results: [
      {
        url: 'https://example.com/',
        audit: {
          url: 'https://example.com/',
          preset: 'mobile',
          runs: 3,
          capturedAt: '2026-11-02T00:00:00.000Z',
          metrics: { ...METRICS },
          heaviest: [],
          violations: [],
          samples: [
            { ...METRICS, lcp: 1480, cls: 0.01 },
            { ...METRICS, lcp: 1610, cls: 0.02 },
          ],
        },
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
        ],
      },
    ],
    failed: 0,
    warned: 0,
    passed: 2,
    ...overrides,
  };
}

function apiEntry(): ApiReportEntry {
  return {
    url: 'https://api.example.com/items',
    method: 'GET',
    result: {
      url: 'https://api.example.com/items',
      method: 'GET',
      runs: 2,
      capturedAt: '2026-11-02T00:00:00.000Z',
      metrics: { ttfb: 120, duration: 300, bytes: 2048, status: 200 },
      samples: [
        { ttfb: 100, duration: 280, bytes: 2048, status: 200 },
        { ttfb: 140, duration: 320, bytes: 2048, status: 200 },
      ],
    },
    baseline: null,
    checks: [
      check({ metric: 'ttfb', label: 'TTFB', value: 120, formatted: '120ms' }),
      check({ metric: 'duration', label: 'Duration', value: 300, formatted: '300ms' }),
      check({
        metric: 'status',
        label: 'HTTP status',
        value: 200,
        formatted: '200',
        format: 'count',
        max: undefined,
        reason: 'within expected status',
      }),
    ],
  };
}

describe('renderMarkdown', () => {
  it('renders the existing table without summary markers', () => {
    const markdown = renderMarkdown(report());

    expect(markdown).toContain('### https://example.com/');
    expect(markdown).toContain('| Check | Result | Budget | vs baseline | Status |');
    expect(markdown).not.toContain('<!-- pulse:start -->');
  });

  it('adds a run-spread line when samples >= 2', () => {
    const markdown = renderMarkdown(report());

    expect(markdown).toContain('**Run spread**: LCP 1.48–1.61s · CLS 0.010–0.020');
  });

  it('omits the run-spread line with a single sample', () => {
    const single = report();
    single.results[0].audit.samples = [{ ...METRICS }];

    expect(renderMarkdown(single)).not.toContain('Run spread');
  });

  it('adds a long tasks bullet only when tasks were recorded', () => {
    expect(renderMarkdown(report())).not.toContain('Long tasks');

    const busy = report();
    busy.results[0].audit.metrics.longTasks = 3;
    busy.results[0].audit.longTaskDetails = [
      { url: 'https://example.com/app.js', startTime: 100, duration: 320 },
    ];

    expect(renderMarkdown(busy)).toContain(
      '- **Long tasks**: 3 ≥ 50ms · longest 320ms (https://example.com/app.js)',
    );
  });

  it('lists up to five failed requests as bullets', () => {
    const withFailures = report();
    withFailures.results[0].audit.metrics.failedRequests = 6;
    withFailures.results[0].audit.failedRequestDetails = Array.from({ length: 6 }, (_, index) => ({
      url: `https://example.com/missing-${index}.png`,
      resourceType: 'Image',
      bytes: 0,
      thirdParty: false,
      statusCode: 404,
      failed: true,
    }));

    const markdown = renderMarkdown(withFailures);
    expect(markdown.match(/\*\*Failed request\*\*/g)).toHaveLength(5);
    expect(markdown).toContain('404 `https://example.com/missing-0.png` (Image)');
    expect(markdown).not.toContain('missing-5.png');
  });

  it('adds a compact bullet for console errors, capped at five', () => {
    const withErrors = report();
    withErrors.results[0].audit.metrics = { ...METRICS, consoleErrors: 7 };
    withErrors.results[0].audit.consoleErrorDetails = Array.from({ length: 7 }, (_, index) => ({
      description: `Error ${index + 1}`,
    }));

    const markdown = renderMarkdown(withErrors);

    expect(markdown).toContain(
      '- **Console errors** (7): Error 1; Error 2; Error 3; Error 4; Error 5 (+2 more)',
    );
    expect(markdown).not.toContain('Error 6');
  });

  it('omits the console errors bullet when the page logged none', () => {
    expect(renderMarkdown(report())).not.toContain('Console errors');
  });

  it('renders API timings in a separate section', () => {
    const markdown = renderMarkdown(report({ apiResults: [apiEntry()] }));

    expect(markdown).toContain('## API timings');
    expect(markdown).toContain('### GET https://api.example.com/items');
    expect(markdown).toContain('**Response**: 200 · 2.0 KB · 2 runs');
    expect(markdown).toContain('| TTFB | 120ms |');
    expect(markdown).toContain('**Run spread**: TTFB 100–140ms');
  });

  it('adds a third-party main-thread bullet when the metric is above zero', () => {
    const withCpu = report();
    withCpu.results[0].audit.metrics.thirdPartyMainThread = 640;

    expect(renderMarkdown(withCpu)).toContain('- **Third-party main thread**: 640ms');
    expect(renderMarkdown(report())).not.toContain('Third-party main thread');
  });
});

describe('upsertSummary', () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pulse-summary-'));
    path = join(directory, 'SUMMARY.md');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('replaces an existing block and preserves surrounding content', async () => {
    await writeFile(
      path,
      '# Log\n\nIntro text.\n\n<!-- pulse:start -->\nold body\n<!-- pulse:end -->\n\nTail text.\n',
      'utf8',
    );

    await upsertSummary(path, '## Pulse audit\n\nfresh body\n');
    const content = await readFile(path, 'utf8');

    expect(content).toContain('# Log\n\nIntro text.');
    expect(content).toContain('Tail text.');
    expect(content).toContain('fresh body');
    expect(content).not.toContain('old body');
    expect(content.match(/<!-- pulse:start -->/g)).toHaveLength(1);
    expect(content.match(/<!-- pulse:end -->/g)).toHaveLength(1);
  });

  it('does not duplicate sections on repeated runs', async () => {
    await upsertSummary(path, '## Pulse audit\n\nfirst body\n');
    await upsertSummary(path, '## Pulse audit\n\nsecond body\n');
    const content = await readFile(path, 'utf8');

    expect(content.match(/<!-- pulse:start -->/g)).toHaveLength(1);
    expect(content.match(/<!-- pulse:end -->/g)).toHaveLength(1);
    expect(content).toContain('second body');
    expect(content).not.toContain('first body');
  });

  it('creates the block when the file does not exist', async () => {
    await upsertSummary(path, '## Pulse audit\n\nnew file body\n');
    const content = await readFile(path, 'utf8');

    expect(content.startsWith('<!-- pulse:start -->\n')).toBe(true);
    expect(content).toContain('new file body');
    expect(content.endsWith('<!-- pulse:end -->\n')).toBe(true);
  });

  it('refuses to truncate a file with an unclosed start marker', async () => {
    const original = '# Log\n\n<!-- pulse:start -->\nold body\nkeep this tail\n';
    await writeFile(path, original, 'utf8');

    await expect(upsertSummary(path, 'fresh body')).rejects.toThrow(/without a matching/);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('refuses to append next to a stray end marker', async () => {
    const original = '# Log\n\nold body\n<!-- pulse:end -->\n';
    await writeFile(path, original, 'utf8');

    await expect(upsertSummary(path, 'fresh body')).rejects.toThrow(/without a matching/);
    expect(await readFile(path, 'utf8')).toBe(original);
  });
});
