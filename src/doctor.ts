import { mkdir, readFile } from 'node:fs/promises';
import { findChromeBinary } from './chrome.js';
import { baselineKey, baselinePath, readBaseline } from './baseline.js';
import { loadConfig, resolveTargets } from './config.js';
import type { BaselineFile, PulseConfig } from './types.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  configPath?: string;
  baselinePath?: string;
  skipNetwork?: boolean;
  /** Injection point for tests; defaults to chrome-launcher + CHROME_PATH. */
  checkChrome?: () => Promise<{ ok: boolean; detail: string }>;
  /** Injection point for tests; defaults to a HEAD-then-GET fetch. */
  checkUrl?: (url: string) => Promise<{ ok: boolean; detail: string }>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `resolveTargets` returns one plain URL, but the config type is wider. */
function targetUrl(page: PulseConfig): string {
  const target = page.urls[0];
  return typeof target === 'string' ? target : target.url;
}

function checkNode(): DoctorCheck {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isFinite(major) && major >= 20) {
    return { name: 'node', status: 'pass', detail: `v${version}` };
  }
  return {
    name: 'node',
    status: 'fail',
    detail: `v${version}; Pulse requires Node.js 20 or newer`,
  };
}

async function checkChrome(): Promise<{ ok: boolean; detail: string }> {
  const found = findChromeBinary();
  return {
    ok: Boolean(found.path),
    detail: found.warning ? `${found.detail} — ${found.warning}` : found.detail,
  };
}

/** HEAD first because it is cheap; some servers reject it, so fall back to GET. */
async function checkUrl(url: string): Promise<{ ok: boolean; detail: string }> {
  const request = async (method: 'HEAD' | 'GET'): Promise<Response> =>
    fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });

  try {
    let response = await request('HEAD');
    if (!response.ok) response = await request('GET');
    const detail = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    return { ok: response.ok, detail };
  } catch (headError) {
    try {
      const response = await request('GET');
      const detail = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
      return { ok: response.ok, detail };
    } catch {
      return { ok: false, detail: message(headError) };
    }
  }
}

async function inspectBaseline(path: string): Promise<{ check: DoctorCheck; baseline?: BaselineFile }> {
  let rawText: string;
  try {
    rawText = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        check: {
          name: 'baseline',
          status: 'warn',
          detail: `no baseline at ${path}; run "pulse audit --update-baseline" to create one`,
        },
      };
    }
    return { check: { name: 'baseline', status: 'fail', detail: message(error) } };
  }

  let rawVersion: unknown;
  try {
    const parsed: unknown = JSON.parse(rawText);
    rawVersion = isRecord(parsed) ? parsed.version : undefined;
  } catch (error) {
    return { check: { name: 'baseline', status: 'fail', detail: message(error) } };
  }

  try {
    const baseline = await readBaseline(path);
    const count = Object.keys(baseline.results).length;
    const version = rawVersion === 1 ? 'version 1 (migrated in memory)' : `version ${String(rawVersion)}`;
    return {
      check: {
        name: 'baseline',
        status: 'pass',
        detail: `${path}: ${version}, ${count} entr${count === 1 ? 'y' : 'ies'}`,
      },
      baseline,
    };
  } catch (error) {
    return { check: { name: 'baseline', status: 'fail', detail: message(error) } };
  }
}

function checkTargets(config: PulseConfig, baseline: BaselineFile): DoctorCheck[] {
  return resolveTargets(config).map((page) => {
    const url = targetUrl(page);
    const key = baselineKey(page.preset, url);
    const name = `baseline ${page.preset} ${url}`;
    const entry = baseline.results[key];

    if (!entry) {
      return { name, status: 'warn', detail: `no baseline entry for ${key}` };
    }
    if (entry.preset !== page.preset || entry.runs !== page.runs) {
      return {
        name,
        status: 'fail',
        detail: `entry is ${entry.preset}, ${entry.runs} run${entry.runs === 1 ? '' : 's'}; config expects ${page.preset}, ${page.runs}`,
      };
    }
    return { name, status: 'pass', detail: key };
  });
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [checkNode()];

  const chrome = await (options.checkChrome ?? checkChrome)();
  checks.push({
    name: 'chrome',
    status: chrome.ok ? 'pass' : 'fail',
    detail: chrome.detail,
  });

  let config: PulseConfig | undefined;
  try {
    config = await loadConfig(options.configPath ?? '.pulse.json');
    checks.push({
      name: 'config',
      status: 'pass',
      detail: `${options.configPath ?? '.pulse.json'} (${config.urls.length} URL${config.urls.length === 1 ? '' : 's'})`,
    });
  } catch (error) {
    checks.push({ name: 'config', status: 'fail', detail: message(error) });
  }

  if (config) {
    const outDir = config.report.outDir;
    try {
      await mkdir(outDir, { recursive: true });
      checks.push({ name: 'report', status: 'pass', detail: `${outDir} is writable` });
    } catch (error) {
      checks.push({ name: 'report', status: 'fail', detail: `${outDir}: ${message(error)}` });
    }
  }

  const resolvedBaselinePath =
    options.baselinePath ?? (config ? baselinePath(config.report.outDir) : '.pulse/baseline.json');
  const inspected = await inspectBaseline(resolvedBaselinePath);
  checks.push(inspected.check);

  if (config && inspected.baseline) {
    checks.push(...checkTargets(config, inspected.baseline));
  }

  if (!options.skipNetwork && config) {
    const reachable = options.checkUrl ?? checkUrl;
    for (const page of resolveTargets(config)) {
      const url = targetUrl(page);
      const result = await reachable(url);
      checks.push({
        name: `url ${url}`,
        status: result.ok ? 'pass' : 'fail',
        detail: result.detail,
      });
    }
  }

  return { ok: !checks.some((check) => check.status === 'fail'), checks };
}
