import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Launcher } from 'chrome-launcher';
import type { PulseConfig, PulseReport } from '../../src/types.js';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function chromeAvailable(): boolean {
  if (process.env.CHROME_PATH) return true;
  try {
    return Launcher.getInstallations().length > 0;
  } catch {
    return false;
  }
}

/** Locate npm-cli.js even when the test runner was not started by npm. */
export function findNpmCli(): string {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules/npm/bin/npm-cli.js'),
  ];
  const found = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!found) throw new Error('Could not find npm-cli.js; run the package flow through npm.');
  return found;
}

/**
 * Runs the built CLI exactly as a user would (`node dist/cli.js ...`) in an
 * isolated working directory.
 */
export async function runCli(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<CliResult> {
  return runCommand(process.execPath, [CLI, ...args], options);
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        command,
        args,
        {
          cwd: options.cwd,
          env: { ...process.env, NO_COLOR: '1', ...options.env },
          timeout: options.timeout ?? 240_000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(Object.assign(error, { stdout, stderr }));
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
    };
  }
}

export async function makeWorkspace(prefix = 'pulse-flow-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function writeConfig(dir: string, config: PulseConfig, name = '.pulse.json'): Promise<void> {
  await writeFile(path.join(dir, name), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export async function readReport(dir: string, outDir = '.pulse'): Promise<PulseReport> {
  return JSON.parse(await readFile(path.join(dir, outDir, 'report.json'), 'utf8')) as PulseReport;
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

/** Generous budgets: the fixture should pass every minimum. */
export function passingConfig(url: string, overrides: Partial<PulseConfig> = {}): PulseConfig {
  return {
    preset: 'mobile',
    runs: 1,
    urls: [url],
    budgets: {
      lcp: { max: 10_000, regression: 50 },
      cls: { max: 1, regression: 50 },
      tbt: { max: 1_000, severity: 'warn' },
      js: { max: 1_000_000, regression: 50 },
      images: { max: 1_000_000, regression: 50 },
      requests: { max: 50, regression: 50 },
      a11y: { maxViolations: 10, maxNew: 5 },
    },
    report: { outDir: '.pulse' },
    ...overrides,
  };
}
