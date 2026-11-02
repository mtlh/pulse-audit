import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/doctor.js';

const URL = 'https://example.com/';

describe('doctor', () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function workspace(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'pulse-doctor-'));
    workspaces.push(dir);
    return dir;
  }

  async function writeConfig(dir: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const configPath = path.join(dir, '.pulse.json');
    await writeFile(
      configPath,
      JSON.stringify({
        preset: 'mobile',
        runs: 3,
        strict: false,
        retries: 1,
        timeoutMs: 120_000,
        urls: [URL],
        report: { outDir: path.join(dir, '.pulse') },
        ...overrides,
      }),
      'utf8',
    );
    return configPath;
  }

  it('fails when the config is missing', async () => {
    const dir = await workspace();
    const result = await runDoctor({
      configPath: path.join(dir, '.pulse.json'),
      skipNetwork: true,
    });

    expect(result.ok).toBe(false);
    const config = result.checks.find((check) => check.name === 'config');
    expect(config?.status).toBe('fail');
    expect(config?.detail).toContain('No config found');
  });

  it('passes config and report checks and always reports the Chrome check', async () => {
    const dir = await workspace();
    const configPath = await writeConfig(dir);

    const result = await runDoctor({ configPath, skipNetwork: true });

    expect(result.checks.find((check) => check.name === 'config')?.status).toBe('pass');
    expect(result.checks.find((check) => check.name === 'report')?.status).toBe('pass');

    // Chrome may be absent in CI; the check must be present but need not pass.
    const chrome = result.checks.find((check) => check.name === 'chrome');
    expect(chrome).toBeDefined();
    expect(['pass', 'fail']).toContain(chrome?.status);

    // No baseline is a warning, not a failure.
    const baseline = result.checks.find((check) => check.name === 'baseline');
    expect(baseline?.status).toBe('warn');
  });

  it('reads a version 1 baseline through the migration path', async () => {
    const dir = await workspace();
    const configPath = await writeConfig(dir);
    const baselinePath = path.join(dir, '.pulse/baseline.json');
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(
      baselinePath,
      JSON.stringify({
        version: 1,
        results: {
          [URL]: {
            url: URL,
            preset: 'mobile',
            runs: 3,
            capturedAt: '2026-11-02T00:00:00.000Z',
            metrics: { lcp: 1500 },
          },
        },
      }),
      'utf8',
    );

    const result = await runDoctor({ configPath, baselinePath, skipNetwork: true });

    const baseline = result.checks.find((check) => check.name === 'baseline');
    expect(baseline?.status).toBe('pass');
    expect(baseline?.detail).toContain('version 1');
    expect(baseline?.detail).toContain('migrated');

    const target = result.checks.find((check) => check.name === `baseline mobile ${URL}`);
    expect(target?.status).toBe('pass');
  });

  it('fails an incompatible baseline entry instead of comparing it', async () => {
    const dir = await workspace();
    const configPath = await writeConfig(dir);
    const baselinePath = path.join(dir, '.pulse/baseline.json');
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(
      baselinePath,
      JSON.stringify({
        version: 2,
        results: {
          [`mobile::${URL}`]: {
            url: URL,
            preset: 'mobile',
            runs: 1,
            capturedAt: '2026-11-02T00:00:00.000Z',
            metrics: { lcp: 1500 },
          },
        },
      }),
      'utf8',
    );

    const result = await runDoctor({ configPath, baselinePath, skipNetwork: true });

    const target = result.checks.find((check) => check.name === `baseline mobile ${URL}`);
    expect(target?.status).toBe('fail');
    expect(target?.detail).toContain('1 run');
    expect(result.ok).toBe(false);
  });
});
