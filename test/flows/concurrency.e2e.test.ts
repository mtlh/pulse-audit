import { describe, expect, it } from 'vitest';
import { chromeAvailable, passingConfig, readReport, runCli, useFixture, writeConfig } from './helpers.js';

const enabled = process.env.PULSE_E2E === '1';
const chrome = chromeAvailable();

describe.skipIf(!enabled || !chrome)('user flow: bounded URL concurrency', () => {
  const flow = useFixture();

  it('audits different URLs with overlap and keeps config order in the report', async () => {
    const dir = await flow.workspace();
    const urls = [`${flow.site.url}?first=1`, `${flow.site.url}?second=1`];
    const config = passingConfig(urls[0]);
    config.urls = urls;
    config.concurrency = 2;
    await writeConfig(dir, config);

    const result = await runCli(['audit', '--concurrency', '2'], { cwd: dir });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(`auditing ${urls[0]}`);
    expect(result.stderr).toContain(`auditing ${urls[1]}`);
    // Multiple targets prefix each run line with its URL so interleaved logs
    // stay attributable.
    expect(result.stderr).toContain(`${urls[0]} run 1/1`);
    expect(result.stderr).toContain(`${urls[1]} run 1/1`);

    const report = await readReport(dir);
    expect(report.results.map((entry) => entry.url)).toEqual(urls);
    expect(report.results.every((entry) => entry.checks.every((check) => check.status === 'pass'))).toBe(
      true,
    );
  });
});
