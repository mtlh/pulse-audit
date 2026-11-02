import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdown, upsertSummary } from '../src/reporters/summary.js';
import type { AuditMetrics, Check, PulseReport } from '../src/types.js';

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
  thirdPartyBytes: 0,
  thirdPartyRequests: 0,
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
    version: '2',
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
});
