import { describe, expect, it } from 'vitest';
import type { PulseReport } from '../../src/types.js';
import { chromeAvailable, passingConfig, runCli, useFixture, writeConfig } from './helpers.js';

const enabled = process.env.PULSE_E2E === '1';
const chrome = chromeAvailable();

describe.skipIf(!enabled || !chrome)('user flow: machine-readable output', () => {
  const flow = useFixture();

  it('keeps stdout machine-readable with --json and honors --fail-on warn', async () => {
    const dir = await flow.workspace();
    const config = passingConfig(flow.site.url);
    config.budgets.js = { max: 1000, regression: 50, severity: 'warn' };
    await writeConfig(dir, config);

    const result = await runCli(['audit', '--json', '--fail-on', 'warn'], { cwd: dir });

    expect(result.code).toBe(1);
    expect(result.stdout.trim().startsWith('{')).toBe(true);
    expect(result.stdout.trim().endsWith('}')).toBe(true);

    const report = JSON.parse(result.stdout) as PulseReport;
    expect(report.warned).toBeGreaterThan(0);
    expect(report.results[0].checks.find((check) => check.metric === 'js')?.status).toBe('warn');

    // Paths and progress belong on stderr so stdout can be piped into a JSON tool.
    expect(result.stderr).toContain('report.json');
    expect(result.stderr).toContain('report.html');
  });
});
