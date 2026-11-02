import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorkspace, readJson, removeWorkspace, runCli } from './helpers.js';

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
      budgets: { lcp: { max: number }; a11y: { maxViolations: number } };
      report: { outDir: string };
    }>(path.join(dir, '.pulse.json'));
    expect(config.urls).toEqual(['https://example.com/']);
    expect(config.preset).toBe('mobile');
    expect(config.runs).toBe(3);
    expect(config.budgets.lcp.max).toBe(2500);
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
    expect(JSON.parse(raw).budgets.a11y).toEqual({ maxViolations: 0, maxNew: 0 });
  });
});
