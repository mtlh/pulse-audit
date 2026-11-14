import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BudgetSet } from '../../src/types.js';
import { chromeAvailable, passingConfig, readReport, runCli, useFixture, writeConfig } from './helpers.js';

const enabled = process.env.PULSE_E2E === '1';
const chrome = chromeAvailable();

const FAST_BUDGETS: BudgetSet = {
  js: { max: 1_000_000, regression: 50 },
  images: { max: 1_000_000, regression: 50 },
  total: { max: 5_000_000, regression: 50 },
  requests: { max: 100, regression: 50 },
  a11y: { maxViolations: 10, maxNew: 0 },
};

describe.skipIf(!enabled || !chrome)('user flow: --fast pre-check', () => {
  const flow = useFixture();

  it('reports a clean page as fast, warns, and refuses to update the baseline', async () => {
    const dir = await flow.workspace();
    await writeConfig(dir, passingConfig(flow.site.url, { budgets: FAST_BUDGETS }));

    const seeded = await runCli(['audit', '--update-baseline'], { cwd: dir });
    expect(seeded.code).toBe(0);
    const baselinePath = path.join(dir, '.pulse/baseline.json');
    const before = await readFile(baselinePath, 'utf8');

    const fast = await runCli(['audit', '--fast', '--update-baseline'], { cwd: dir });

    expect(fast.code).toBe(0);
    expect(fast.stderr).toContain('warning: --fast runs a cheap pre-check');
    expect(fast.stderr).toContain('fast pre-check passed');
    expect(fast.stderr).toContain('Baseline not updated: --fast never writes a baseline');
    expect(await readFile(baselinePath, 'utf8')).toBe(before);

    const report = await readReport(dir);
    expect(report.version).toBe('4');
    expect(report.results[0].method).toBe('fast');
    expect(report.results[0].enforcedBudgets).toEqual(
      expect.arrayContaining(['a11y', 'js', 'images', 'total', 'requests']),
    );
    expect(report.results[0].audit.metrics.lcp).toBe(0);
    expect(report.results[0].checks.every((check) => check.status === 'pass')).toBe(true);

    const html = await readFile(path.join(dir, '.pulse/report.html'), 'utf8');
    expect(html).toContain('Fast pre-check');
    const summary = path.join(dir, 'summary.md');
    const withSummary = await runCli(['audit', '--fast', '--summary', summary], { cwd: dir });
    expect(withSummary.code).toBe(0);
    expect(await readFile(summary, 'utf8')).toContain('Fast pre-check');
  });

  it('escalates an injected a11y regression instead of silently passing it', async () => {
    const dir = await flow.workspace();
    await writeConfig(dir, passingConfig(flow.site.url, { budgets: FAST_BUDGETS }));
    expect((await runCli(['audit', '--update-baseline'], { cwd: dir })).code).toBe(0);

    flow.site.state.extraViolation = true;
    const regressed = await runCli(['audit', '--fast'], { cwd: dir });

    expect(regressed.code).toBe(1);
    expect(regressed.stderr).toContain('escalated to Lighthouse');
    expect(regressed.stderr).toContain('accessibility findings changed');

    const report = await readReport(dir);
    expect(report.results[0].method).toBe('lighthouse');
    const a11yNew = report.results[0].checks.find((check) => check.metric === 'a11yNew');
    expect(a11yNew?.status).toBe('fail');
  });
});
