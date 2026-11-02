import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PulseConfig } from '../../src/types.js';
import { chromeAvailable, readJson, readReport, runCli, useFixture } from './helpers.js';

const enabled = process.env.PULSE_E2E === '1';
const chrome = chromeAvailable();

describe.skipIf(!enabled || !chrome)('user flow: init --from', () => {
  const flow = useFixture();

  it('derives minimums from a measured page', async () => {
    const dir = await flow.workspace();

    const initialized = await runCli(['init', '--from', flow.site.url], { cwd: dir, timeout: 240_000 });
    expect(initialized.code).toBe(0);
    expect(initialized.stderr).toContain(`measured ${flow.site.url}`);
    expect(initialized.stdout).toContain('metric');

    const config = await readJson<PulseConfig>(path.join(dir, '.pulse.json'));
    expect(config.urls).toEqual([flow.site.url]);
    expect(config.budgets.lcp?.max).toBeGreaterThan(1000);
    expect(config.budgets.js?.max).toBeGreaterThan(200_000);
    expect(config.budgets.a11y?.maxViolations).toBeGreaterThanOrEqual(3);

    // The generated definition should verify the page it came from.
    const audited = await runCli(['audit'], { cwd: dir });
    expect(audited.code).toBe(0);
    expect((await readReport(dir)).failed).toBe(0);
  });
});
