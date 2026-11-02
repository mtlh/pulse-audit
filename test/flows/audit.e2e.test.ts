import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BaselineFile, PulseConfig } from '../../src/types.js';
import { startFixture, type FixtureSite } from './fixture.js';
import {
  chromeAvailable,
  makeWorkspace,
  passingConfig,
  readJson,
  readReport,
  removeWorkspace,
  runCli,
  writeConfig,
} from './helpers.js';

const enabled = process.env.PULSE_E2E === '1';
const chrome = chromeAvailable();

describe.skipIf(!enabled || !chrome)('user flow: audit a site against minimums', () => {
  let site: FixtureSite;
  const workspaces: string[] = [];

  beforeAll(async () => {
    site = await startFixture();
  }, 60_000);

  afterAll(async () => {
    await site.close();
  });

  afterEach(async () => {
    site.state.extraViolation = false;
    await Promise.all(workspaces.splice(0).map(removeWorkspace));
  });

  async function workspace(): Promise<string> {
    const dir = await makeWorkspace('pulse-audit-');
    workspaces.push(dir);
    return dir;
  }

  it('passes a page that meets every minimum and writes every output', async () => {
    const dir = await workspace();
    await writeConfig(dir, passingConfig(site.url));
    const githubOutput = path.join(dir, 'github-output.txt');

    const result = await runCli(['audit', '--summary', 'summary.md', '--github-output'], {
      cwd: dir,
      env: { GITHUB_OUTPUT: githubOutput },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('8 passed');
    expect(result.stderr).toContain('1 measured run + warm-up');

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
    expect(output).toContain('failed=0');
  });

  it('fails a page below its minimum, and --no-fail keeps the job alive', async () => {
    const dir = await workspace();
    const config = passingConfig(site.url);
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

  it('establishes a baseline, reports deltas, ignores a run-count mismatch and catches new axe debt', async () => {
    const dir = await workspace();
    const base = passingConfig(site.url);
    base.budgets.a11y = { maxViolations: 10, maxNew: 0 };
    await writeConfig(dir, base);

    const seeded = await runCli(['audit', '--update-baseline'], { cwd: dir });
    expect(seeded.code).toBe(0);
    expect(seeded.stdout).toContain('no baseline yet; existing violations are recorded but not gated');

    const baseline = await readJson<BaselineFile>(path.join(dir, '.pulse/baseline.json'));
    expect(baseline.results[site.url].runs).toBe(1);
    expect(baseline.results[site.url].metrics.violations).toBeGreaterThanOrEqual(3);

    const second = await runCli(['audit'], { cwd: dir });
    expect(second.code).toBe(0);
    const secondReport = await readReport(dir);
    const lcp = secondReport.results[0].checks.find((check) => check.metric === 'lcp');
    expect(typeof lcp?.baseline).toBe('number');
    expect(typeof lcp?.delta).toBe('number');
    expect(secondReport.results[0].baseline).not.toBeNull();

    const mismatch = await runCli(['audit', '--runs', '2'], { cwd: dir });
    expect(mismatch.code).toBe(0);
    expect(mismatch.stderr).toContain('Ignoring baseline');
    const mismatchReport = await readReport(dir);
    expect(mismatchReport.runs).toBe(2);
    expect(mismatchReport.results[0].baseline).toBeNull();
    expect(mismatchReport.results[0].checks.find((check) => check.metric === 'lcp')?.delta).toBeUndefined();

    site.state.extraViolation = true;
    const regressed = await runCli(['audit'], { cwd: dir });
    expect(regressed.code).toBe(1);
    const regressedReport = await readReport(dir);
    const a11yNew = regressedReport.results[0].checks.find((check) => check.metric === 'a11yNew');
    expect(a11yNew?.status).toBe('fail');
    expect((a11yNew?.value ?? 0)).toBeGreaterThan(0);
    expect(regressed.stdout).toContain('New a11y violations');
  });

  it('derives minimums from a measured page with init --from', async () => {
    const dir = await workspace();

    const initialized = await runCli(['init', '--from', site.url], { cwd: dir, timeout: 240_000 });
    expect(initialized.code).toBe(0);
    expect(initialized.stderr).toContain(`measured ${site.url}`);
    expect(initialized.stdout).toContain('metric');

    const config = await readJson<PulseConfig>(path.join(dir, '.pulse.json'));
    expect(config.urls).toEqual([site.url]);
    expect(config.budgets.lcp?.max).toBeGreaterThan(1000);
    expect(config.budgets.js?.max).toBeGreaterThan(200_000);
    expect(config.budgets.a11y?.maxViolations).toBeGreaterThanOrEqual(3);

    // The generated definition should verify the page it came from.
    const audited = await runCli(['audit'], { cwd: dir });
    expect(audited.code).toBe(0);
    expect((await readReport(dir)).failed).toBe(0);
  });

  it('audits the desktop preset when asked', async () => {
    const dir = await workspace();
    const config: PulseConfig = passingConfig(site.url, { preset: 'desktop' });
    await writeConfig(dir, config);

    const result = await runCli(['audit'], { cwd: dir });
    expect(result.code).toBe(0);
    const report = await readReport(dir);
    expect(report.preset).toBe('desktop');
    expect(report.results[0].audit.preset).toBe('desktop');
    expect(report.results[0].audit.metrics.lcp).toBeGreaterThan(0);
  });
});
