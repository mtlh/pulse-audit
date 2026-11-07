import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BaselineFile, PulseConfig } from '../../src/types.js';
import { fixtureAuth, startFixture, type FixtureSite } from './fixture.js';
import { makeWorkspace, readJson, readReport, removeWorkspace, runCli, writeConfig } from './helpers.js';

describe('user flow: API-only config', () => {
  let site: FixtureSite;
  const workspaces: string[] = [];

  beforeAll(async () => {
    site = await startFixture();
  }, 60_000);

  afterAll(async () => {
    await site.close();
    await Promise.all(workspaces.splice(0).map(removeWorkspace));
  });

  it('audits endpoints without a page URL and writes an API baseline', async () => {
    const dir = await makeWorkspace('pulse-api-only-');
    workspaces.push(dir);
    const origin = new URL(site.url).origin;

    const config: PulseConfig = {
      preset: 'mobile',
      runs: 1,
      strict: false,
      retries: 0,
      timeoutMs: 30_000,
      urls: [],
      budgets: {},
      api: [
        {
          url: `${origin}/api/private`,
          auth: { type: 'bearer', token: '${PULSE_TEST_TOKEN}' },
          runs: 2,
          budgets: {
            ttfb: { max: 10_000, regression: 50 },
            duration: { max: 10_000, regression: 50 },
          },
        },
      ],
      apiBudgets: {},
      report: { outDir: '.pulse' },
    };
    await writeConfig(dir, config);

    const seeded = await runCli(['audit', '--update-baseline'], {
      cwd: dir,
      env: { PULSE_TEST_TOKEN: fixtureAuth.token },
    });
    expect(seeded.code).toBe(0);

    const report = await readReport(dir);
    expect(report.results).toEqual([]);
    expect(report.apiResults).toHaveLength(1);
    expect(report.runs).toBe(2);
    expect(report.apiResults?.[0]?.result.metrics.status).toBe(200);
    expect(report.failed).toBe(0);

    const baseline = await readJson<BaselineFile>(path.join(dir, '.pulse/baseline.json'));
    expect(baseline.results).toEqual({});
    expect(Object.keys(baseline.apiResults ?? {})).toHaveLength(1);

    const html = await readFile(path.join(dir, '.pulse/report.html'), 'utf8');
    expect(html).toContain('API timings');
    expect(html).not.toContain('UI pages');
    expect(html.length).toBeLessThan(100_000);

    const compared = await runCli(['audit'], {
      cwd: dir,
      env: { PULSE_TEST_TOKEN: fixtureAuth.token },
    });
    expect(compared.code).toBe(0);
    expect((await readReport(dir)).apiResults?.[0]?.baseline).not.toBeNull();
  }, 30_000);
});
