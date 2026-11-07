import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BaselineFile } from '../../src/types.js';
import { fixtureAuth } from './fixture.js';
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

describe.skipIf(!enabled || !chrome)('user flow: authenticated UI and API timings', () => {
  const flow = useFixture();

  it('audits a protected page, measures API endpoints and keeps both tables separate', async () => {
    const dir = await flow.workspace();
    const origin = new URL(flow.site.url).origin;

    flow.site.state.requireAuth = true;

    const config = passingConfig(flow.site.url, {
      urls: [
        {
          url: flow.site.url,
          auth: { type: 'bearer', token: '${PULSE_TEST_TOKEN}' },
        },
      ],
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
        {
          url: `${origin}/api/echo`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"hello":"world"}',
          runs: 1,
          expectStatus: [200],
          budgets: { duration: { max: 10_000, regression: 50 } },
        },
      ],
      apiBudgets: {
        ttfb: { max: 10_000, regression: 50, severity: 'warn' },
        duration: { max: 10_000, regression: 50, severity: 'warn' },
      },
    });

    await writeConfig(dir, config);

    const first = await runCli(['audit', '--update-baseline', '--summary', 'summary.md'], {
      cwd: dir,
      env: { PULSE_TEST_TOKEN: fixtureAuth.token },
      timeout: 240_000,
    });

    expect(first.code).toBe(0);
    expect(first.stderr).toContain('auditing API GET');
    expect(first.stderr).toContain('auditing API POST');

    const report = await readReport(dir);
    expect(report.results).toHaveLength(1);
    expect(report.apiResults).toHaveLength(2);
    expect(report.failed).toBe(0);
    expect(report.apiResults?.map((entry) => entry.method)).toEqual(['GET', 'POST']);
    expect(report.apiResults?.every((entry) => entry.result.metrics.status === 200)).toBe(true);
    expect(report.apiResults?.[0]?.result.metrics.bytes).toBeGreaterThan(1000);
    expect(report.apiResults?.[0]?.result.samples).toHaveLength(2);
    expect(report.apiResults?.[0]?.checks.find((check) => check.metric === 'status')?.status).toBe('pass');

    const baseline = await readJson<BaselineFile>(path.join(dir, '.pulse/baseline.json'));
    expect(Object.keys(baseline.apiResults ?? {})).toHaveLength(2);
    expect(baseline.apiResults?.['api::GET::' + origin + '/api/private']).toBeDefined();

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(fixtureAuth.token);
    expect(serialized).not.toContain('PULSE_TEST_TOKEN');

    const html = await readFile(path.join(dir, '.pulse/report.html'), 'utf8');
    expect(html).toContain('UI pages');
    expect(html).toContain('API timings');
    expect(html).toContain('<span class="method">GET</span>');
    expect(html).toContain('<span class="method">POST</span>');
    expect(html.length).toBeLessThan(120_000);

    const summary = await readFile(path.join(dir, 'summary.md'), 'utf8');
    expect(summary).toContain('## API timings');
    expect(summary).toContain('### GET ' + origin + '/api/private');
    expect(summary).toContain('TTFB');

    const second = await runCli(['audit'], {
      cwd: dir,
      env: { PULSE_TEST_TOKEN: fixtureAuth.token },
    });
    expect(second.code).toBe(0);

    const compared = await readReport(dir);
    const api = compared.apiResults?.[0];
    expect(api?.baseline).not.toBeNull();
    expect(api?.checks.find((check) => check.metric === 'ttfb')?.delta).toEqual(expect.any(Number));

    const shown = await runCli(['baseline', 'show'], { cwd: dir });
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('GET ' + origin + '/api/private');
    expect(shown.stdout).toContain('POST ' + origin + '/api/echo');
    expect(shown.stdout).toContain('TTFB');

    const prune = await runCli(['baseline', 'prune', '--dry-run'], { cwd: dir });
    expect(prune.code).toBe(0);
    expect(prune.stdout).toContain('No stale baseline entries');
  }, 240_000);

  it('reports a missing auth environment variable as a tool error', async () => {
    const dir = await flow.workspace();
    const config = passingConfig(flow.site.url, {
      urls: [
        {
          url: flow.site.url,
          auth: { type: 'bearer', token: '${PULSE_MISSING_TOKEN}' },
        },
      ],
    });
    await writeConfig(dir, config);

    const result = await runCli(['audit'], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('PULSE_MISSING_TOKEN');
  });
});
