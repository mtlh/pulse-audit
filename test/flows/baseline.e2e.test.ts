import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { baselineKey } from '../../src/baseline.js';
import type { BaselineFile } from '../../src/types.js';
import {
  chromeAvailable,
  passingConfig,
  readJson,
  readReport,
  runCli,
  useFixture,
  writeConfig,
} from './helpers.js';

const enabled = process.env.PULSE_E2E === '1';
const chrome = chromeAvailable();

describe.skipIf(!enabled || !chrome)('user flow: baseline bookkeeping', () => {
  const flow = useFixture();

  it('establishes a baseline, reports deltas, ignores a run-count mismatch and catches new axe debt', async () => {
    const dir = await flow.workspace();
    const base = passingConfig(flow.site.url);
    base.budgets.a11y = { maxViolations: 10, maxNew: 0 };
    await writeConfig(dir, base);

    const seeded = await runCli(['audit', '--update-baseline'], { cwd: dir });
    expect(seeded.code).toBe(0);
    expect(seeded.stdout).toContain('no baseline yet; existing violations are recorded but not gated');

    const baseline = await readJson<BaselineFile>(path.join(dir, '.pulse/baseline.json'));
    const baselineEntry = baseline.results[baselineKey('mobile', flow.site.url)];
    expect(baselineEntry.runs).toBe(1);
    expect(baselineEntry.metrics.violations).toBeGreaterThanOrEqual(3);

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

    flow.site.state.extraViolation = true;
    const regressed = await runCli(['audit'], { cwd: dir });
    expect(regressed.code).toBe(1);
    const regressedReport = await readReport(dir);
    const a11yNew = regressedReport.results[0].checks.find((check) => check.metric === 'a11yNew');
    expect(a11yNew?.status).toBe('fail');
    expect(a11yNew?.value ?? 0).toBeGreaterThan(0);
    expect(regressed.stdout).toContain('New a11y violations');
  });
});
