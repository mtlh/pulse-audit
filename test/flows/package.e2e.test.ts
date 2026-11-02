import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFixture, type FixtureSite } from './fixture.js';
import {
  chromeAvailable,
  findNpmCli,
  makeWorkspace,
  passingConfig,
  readJson,
  readReport,
  removeWorkspace,
  runCommand,
  writeConfig,
} from './helpers.js';

const enabled = process.env.PULSE_E2E === '1' && process.env.PULSE_PACKAGE === '1';
const chrome = chromeAvailable();
const npmCli = findNpmCli();

describe.skipIf(!enabled || !chrome)('user flow: install the packed package', () => {
  let site: FixtureSite;
  const workspaces: string[] = [];
  let tarball = '';

  beforeAll(async () => {
    site = await startFixture();
    const packDir = await makeWorkspace('pulse-pack-');
    workspaces.push(packDir);

    const packed = await runCommand(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', packDir], {
      cwd: process.cwd(),
      timeout: 120_000,
    });
    expect(packed.code).toBe(0);
    const [info] = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    tarball = path.join(packDir, info.filename);

    const shipped = info.files.map((file) => file.path);
    expect(shipped).toContain('dist/cli.js');
    expect(shipped).toContain('dist/index.js');
    expect(shipped).toContain('README.md');
    expect(shipped).toContain('LICENSE');
    expect(shipped).not.toContain('action.yml');
    expect(shipped).not.toContain('src/cli.ts');
    expect(shipped.some((file) => file.startsWith('test/'))).toBe(false);
  }, 180_000);

  afterAll(async () => {
    if (site) await site.close();
  });

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(removeWorkspace));
  });

  it('installs, inits and audits through the package binary', async () => {
    const consumer = await makeWorkspace('pulse-consumer-');
    workspaces.push(consumer);

    await writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify({ name: 'pulse-consumer', private: true, type: 'module' }, null, 2),
      'utf8',
    );

    const installed = await runCommand(
      process.execPath,
      [npmCli, 'install', '--no-audit', '--no-fund', '--prefer-offline', tarball],
      { cwd: consumer, timeout: 300_000 },
    );
    expect(installed.code).toBe(0);

    const packageCli = path.join(consumer, 'node_modules', '@mtlh', 'pulse-audit', 'dist', 'cli.js');
    const binShim = path.join(
      consumer,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'pulse.cmd' : 'pulse',
    );
    await expect(access(packageCli)).resolves.toBeUndefined();
    await expect(access(binShim)).resolves.toBeUndefined();

    const version = await runCommand(process.execPath, [packageCli, '--version'], { cwd: consumer });
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe('0.1.0');

    const initialized = await runCommand(process.execPath, [packageCli, 'init', site.url], {
      cwd: consumer,
    });
    expect(initialized.code).toBe(0);
    expect((await readJson<{ urls: string[] }>(path.join(consumer, '.pulse.json'))).urls).toEqual([site.url]);

    // The user reviews the generated minimums and adjusts them for this page.
    await writeConfig(consumer, passingConfig(site.url));

    const audited = await runCommand(process.execPath, [packageCli, 'audit', '--runs', '1'], {
      cwd: consumer,
      timeout: 240_000,
    });
    expect(audited.code).toBe(0);
    expect((await readReport(consumer)).failed).toBe(0);
    expect((await readFile(path.join(consumer, '.pulse/report.html'), 'utf8')).length).toBeLessThan(100_000);
  }, 600_000);
});
