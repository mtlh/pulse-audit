import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromeAvailable, passingConfig, readReport, runCli, useFixture, writeConfig } from './helpers.js';

const enabled = process.env.PULSE_E2E === '1';
const chrome = chromeAvailable();

describe.skipIf(!enabled || !chrome)('user flow: audit a site against minimums', () => {
  const flow = useFixture();

  it('passes a page that meets every minimum and writes every output', async () => {
    const dir = await flow.workspace();
    await writeConfig(dir, passingConfig(flow.site.url));
    const githubOutput = path.join(dir, 'github-output.txt');

    const result = await runCli(['audit', '--summary', 'summary.md', '--github-output'], {
      cwd: dir,
      env: { GITHUB_OUTPUT: githubOutput },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('15 passed');
    expect(result.stderr).toContain('auditing');
    expect(result.stderr).toContain('1 run, navigate warm-up');
    expect(result.stderr).toMatch(/warm-up \d/);
    expect(result.stderr).toMatch(/run 1\/1/);

    const report = await readReport(dir);
    expect(report.failed).toBe(0);
    expect(report.warned).toBe(0);
    expect(report.results[0].checks.every((check) => check.status === 'pass')).toBe(true);

    const audit = report.results[0].audit;
    expect(audit.metrics.lcp).toBeGreaterThan(1000);
    expect(audit.metrics.js).toBeGreaterThan(200_000);
    expect(audit.metrics.images).toBeGreaterThan(150_000);
    expect(audit.metrics.requests).toBeGreaterThanOrEqual(4);
    expect(audit.metrics.violations).toBeGreaterThanOrEqual(3);
    expect(audit.metrics.fcp).toBeGreaterThan(0);
    expect(audit.metrics.ttfb).toBeGreaterThan(0);
    expect(audit.metrics.css).toBeGreaterThanOrEqual(0);
    expect(audit.metrics.fonts).toBeGreaterThanOrEqual(0);
    expect(audit.metrics.total).toBeGreaterThanOrEqual(audit.metrics.js);
    expect(typeof audit.metrics.thirdPartyBytes).toBe('number');
    expect(typeof audit.metrics.thirdPartyRequests).toBe('number');
    expect(audit.samples).toHaveLength(1);
    expect(audit.lcpElement?.selector).toBeTruthy();
    expect(audit.violations.map((violation) => violation.id)).toContain('image-alt');
    expect(audit.violations.map((violation) => violation.id)).toContain('color-contrast');

    const html = await readFile(path.join(dir, '.pulse/report.html'), 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html.length).toBeLessThan(100_000);
    expect(html).not.toMatch(/<script\b/i);

    const summary = await readFile(path.join(dir, 'summary.md'), 'utf8');
    expect(summary).toContain('## Pulse audit');
    expect(summary).toContain('| LCP |');

    const output = await readFile(githubOutput, 'utf8');
    expect(output).toContain('report-path=');
    expect(output).toContain('failed=false');
    expect(output).toContain('failed-count=0');
    expect(output).toContain('warned-count=0');
  });

  it('fails a page below its minimum, and --no-fail keeps the job alive', async () => {
    const dir = await flow.workspace();
    const config = passingConfig(flow.site.url);
    config.budgets.js = { max: 1000, regression: 50 };
    await writeConfig(dir, config);

    const failed = await runCli(['audit'], { cwd: dir });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain('JavaScript');
    expect(failed.stdout).toContain('FAIL');
    expect(failed.stdout).toContain('over max');
    expect(failed.stderr).toContain('1 check failed');

    const report = await readReport(dir);
    expect(report.failed).toBe(1);
    const js = report.results[0].checks.find((check) => check.metric === 'js');
    expect(js?.status).toBe('fail');
    expect(js?.reason).toContain('over max');

    const noFail = await runCli(['audit', '--no-fail'], { cwd: dir });
    expect(noFail.code).toBe(0);
    expect((await readReport(dir)).failed).toBe(1);
  });
});
