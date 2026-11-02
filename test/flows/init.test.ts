import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorkspace, readJson, removeWorkspace, runCli, writeConfig } from './helpers.js';

describe('user flow: initialise a project', () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(removeWorkspace));
  });

  async function workspace(): Promise<string> {
    const dir = await makeWorkspace('pulse-init-');
    workspaces.push(dir);
    return dir;
  }

  it('creates a readable config and refuses to silently overwrite it', async () => {
    const dir = await workspace();

    const created = await runCli(['init', 'https://example.com/'], { cwd: dir });
    expect(created.code).toBe(0);
    expect(created.stdout).toContain('created .pulse.json');
    expect(created.stdout).toContain('audit --update-baseline');

    const config = await readJson<{
      urls: string[];
      runs: number;
      preset: string;
      strict: boolean;
      retries: number;
      timeoutMs: number;
      budgets: {
        lcp: { max: number };
        fcp: { max: number };
        css: { max: number };
        a11y: { maxViolations: number };
      };
      report: { outDir: string };
    }>(path.join(dir, '.pulse.json'));
    expect(config.urls).toEqual(['https://example.com/']);
    expect(config.preset).toBe('mobile');
    expect(config.runs).toBe(3);
    expect(config.strict).toBe(false);
    expect(config.retries).toBe(1);
    expect(config.timeoutMs).toBe(120_000);
    expect(config.budgets.lcp.max).toBe(2500);
    // init serializes normalized numbers, not the readable-unit strings.
    expect(typeof config.budgets.fcp.max).toBe('number');
    expect(typeof config.budgets.css.max).toBe('number');
    expect(config.report.outDir).toBe('.pulse');

    const refused = await runCli(['init', 'https://example.com/'], { cwd: dir });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('already exists');
    expect(refused.stderr).toContain('--force');

    const forced = await runCli(['init', 'https://example.com/', '--force'], { cwd: dir });
    expect(forced.code).toBe(0);
  });

  it('supports a custom config path', async () => {
    const dir = await workspace();

    const created = await runCli(['init', 'https://example.com/', '--out', 'configs/pulse.json'], {
      cwd: dir,
    });
    expect(created.code).toBe(0);
    expect((await stat(path.join(dir, 'configs/pulse.json'))).isFile()).toBe(true);
  });

  it('explains the next step when the config is missing', async () => {
    const dir = await workspace();

    const result = await runCli(['audit'], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('No config found at .pulse.json');
    expect(result.stderr).toContain('pulse init');
  });

  it('reports a bad budget with the exact path instead of crashing', async () => {
    const dir = await workspace();
    await writeFile(
      path.join(dir, '.pulse.json'),
      JSON.stringify({ urls: ['https://example.com/'], budgets: { lcp: { max: 'fast' } } }),
      'utf8',
    );

    const result = await runCli(['audit'], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('budgets.lcp.max');
    expect(result.stderr).toContain('Invalid config');
  });

  it('keeps the config file valid JSON for editors and review', async () => {
    const dir = await workspace();
    await runCli(['init', 'https://example.com/'], { cwd: dir });

    const raw = await readFile(path.join(dir, '.pulse.json'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).budgets.a11y).toEqual({
      maxViolations: 0,
      maxNew: 0,
      maxNewByImpact: { critical: 0, serious: 0 },
    });
  });

  it('reports the version from package.json', async () => {
    const dir = await workspace();

    const result = await runCli(['--version'], { cwd: dir });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('0.1.0');
  });

  it('shows and prunes baseline entries that left the config', async () => {
    const dir = await workspace();
    await writeConfig(dir, {
      preset: 'mobile',
      runs: 3,
      strict: false,
      retries: 1,
      timeoutMs: 120_000,
      urls: ['https://example.com/'],
      budgets: {},
      report: { outDir: '.pulse' },
    });

    await mkdir(path.join(dir, '.pulse'), { recursive: true });
    const entry = (url: string): object => ({
      url,
      preset: 'mobile',
      runs: 3,
      capturedAt: '2026-11-02T00:00:00.000Z',
      lighthouseVersion: '12.8.2',
      metrics: { lcp: 1500 },
    });
    await writeFile(
      path.join(dir, '.pulse/baseline.json'),
      JSON.stringify({
        version: 2,
        results: {
          'mobile::https://example.com/': entry('https://example.com/'),
          'mobile::https://old.example.com/': entry('https://old.example.com/'),
        },
      }),
      'utf8',
    );

    const shown = await runCli(['baseline', 'show'], { cwd: dir });
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('https://old.example.com/');
    expect(shown.stdout).toContain('capturedAt');
    expect(shown.stdout).toContain('12.8.2');

    const dryRun = await runCli(['baseline', 'prune', '--dry-run'], { cwd: dir });
    expect(dryRun.code).toBe(0);
    expect(dryRun.stdout).toContain('Would remove 1 entry');
    expect(
      Object.keys((await readJson<{ results: object }>(path.join(dir, '.pulse/baseline.json'))).results),
    ).toHaveLength(2);

    const pruned = await runCli(['baseline', 'prune'], { cwd: dir });
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain('Removed 1 entry');
    expect(
      Object.keys((await readJson<{ results: object }>(path.join(dir, '.pulse/baseline.json'))).results),
    ).toEqual(['mobile::https://example.com/']);
  });
});
