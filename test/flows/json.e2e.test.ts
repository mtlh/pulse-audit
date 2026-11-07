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

  it('exits 0 with one complete JSON document across repeated --json --quiet runs', async () => {
    const dir = await flow.workspace();
    await writeConfig(dir, passingConfig(flow.site.url));

    // The CLI forces the process to exit once its output is flushed; a
    // truncated write or a lingering Chrome handle would surface as a parse
    // failure here rather than passing once by luck.
    for (let run = 0; run < 2; run += 1) {
      const result = await runCli(['audit', '--json', '--quiet'], { cwd: dir });

      expect(result.code).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(result.stdout.trim().endsWith('}')).toBe(true);

      const report = JSON.parse(result.stdout) as PulseReport;
      expect(report.failed).toBe(0);
      expect(report.results).toHaveLength(1);
      expect(report.results[0].checks.length).toBeGreaterThan(0);
    }
  });

  it('exits 2 with a formatted config error and nothing on stdout', async () => {
    const dir = await flow.workspace();
    await writeConfig(dir, passingConfig(flow.site.url, { urls: [] }));

    const result = await runCli(['audit', '--json'], { cwd: dir });

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid config');
  });
});
