import { describe, expect, it } from 'vitest';
import type { PulseConfig } from '../../src/types.js';
import { chromeAvailable, passingConfig, readReport, runCli, useFixture, writeConfig } from './helpers.js';

const enabled = process.env.PULSE_E2E === '1';
const chrome = chromeAvailable();

describe.skipIf(!enabled || !chrome)('user flow: desktop preset', () => {
  const flow = useFixture();

  it('audits the desktop preset when asked', async () => {
    const dir = await flow.workspace();
    const config: PulseConfig = passingConfig(flow.site.url, { preset: 'desktop' });
    await writeConfig(dir, config);

    const result = await runCli(['audit'], { cwd: dir });
    expect(result.code).toBe(0);
    const report = await readReport(dir);
    expect(report.preset).toBe('desktop');
    expect(report.results[0].audit.preset).toBe('desktop');
    expect(report.results[0].audit.metrics.lcp).toBeGreaterThan(0);
  });
});
