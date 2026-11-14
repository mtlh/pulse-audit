import { mkdir } from 'node:fs/promises';
import { resolveRequestHeaders } from './auth.js';
import { apiBaselineKey, baselineKey, baselinePath, lighthouseMajor, readBaseline } from './baseline.js';
import { findChromeBinary } from './chrome.js';
import { expectedStatus } from './compare.js';
import { loadConfig, resolveApiTargets, resolveTargets, targetUrl } from './config.js';
import { LIGHTHOUSE_VERSION } from './lighthouse-version.js';
import type { BaselineFile, PulseConfig, ResolvedApiTarget } from './types.js';
import { errorMessage, isEnoent } from './util/errors.js';
import { readJsonFile } from './util/files.js';
import { isRecord } from './util/guards.js';

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
  checkChrome?: () => Promise<{ ok: boolean; detail: string; warning?: boolean }>;
  /** Injection point for tests; defaults to a HEAD-then-GET fetch. */
  checkUrl?: (url: string) => Promise<{ ok: boolean; detail: string }>;
  /** Injection point for tests; defaults to the read-only API probe. */
  checkApi?: (target: ResolvedApiTarget) => Promise<{ ok: boolean; detail: string }>;
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

async function checkChrome(): Promise<{ ok: boolean; detail: string; warning?: boolean }> {
  const found = findChromeBinary();
  return {
    ok: Boolean(found.path),
    detail: found.warning ? `${found.detail} — ${found.warning}` : found.detail,
    warning: Boolean(found.warning),
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
      return { ok: false, detail: errorMessage(headError) };
    }
  }
}

/**
 * Doctor only exercises safe API targets. A POST/PUT/PATCH/DELETE request could
 * create data, so those are reported as config-only checks rather than repeated.
 */
async function checkApiTarget(target: ResolvedApiTarget): Promise<{ ok: boolean; detail: string }> {
  if (target.method !== 'GET' && target.method !== 'HEAD') {
    return { ok: true, detail: `${target.method} is configured; doctor does not execute unsafe methods` };
  }

  try {
    const headers = resolveRequestHeaders(target.auth, target.headers);
    const response = await fetch(target.url, {
      method: target.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.min(target.timeoutMs, 10_000)),
    });
    // The status is all doctor needs; canceling the body keeps the check cheap.
    await response.body?.cancel();
    const detail = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    return { ok: expectedStatus(response.status, target.expectStatus), detail };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

async function inspectBaseline(path: string): Promise<{ check: DoctorCheck; baseline?: BaselineFile }> {
  let parsed: unknown;
  try {
    parsed = await readJsonFile(path);
  } catch (error) {
    if (isEnoent(error)) {
      return {
        check: {
          name: 'baseline',
          status: 'warn',
          detail: `no baseline at ${path}; run "pulse audit --update-baseline" to create one`,
        },
      };
    }
    return { check: { name: 'baseline', status: 'fail', detail: errorMessage(error) } };
  }

  const rawVersion = isRecord(parsed) ? parsed.version : undefined;

  try {
    const baseline = await readBaseline(path);
    const uiCount = Object.keys(baseline.results).length;
    const apiCount = Object.keys(baseline.apiResults ?? {}).length;
    const count = uiCount + apiCount;
    const version = rawVersion === 1 ? 'version 1 (migrated in memory)' : `version ${String(rawVersion)}`;
    const breakdown = apiCount > 0 ? ` (${uiCount} URL, ${apiCount} API)` : ` (${uiCount} URL)`;
    return {
      check: {
        name: 'baseline',
        status: 'pass',
        detail: `${path}: ${version}, ${count} entr${count === 1 ? 'y' : 'ies'}${breakdown}`,
      },
      baseline,
    };
  } catch (error) {
    return { check: { name: 'baseline', status: 'fail', detail: errorMessage(error) } };
  }
}

/** The bundled Lighthouse major, used to explain a baseline that cannot compare. */
function installedLighthouseMajor(): number | null {
  return lighthouseMajor(LIGHTHOUSE_VERSION);
}

function checkTargets(
  config: PulseConfig,
  baseline: BaselineFile,
  currentLighthouseMajor: number | null,
): DoctorCheck[] {
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

    const entryMajor = lighthouseMajor(entry.lighthouseVersion);
    if (entryMajor !== null && currentLighthouseMajor !== null && entryMajor !== currentLighthouseMajor) {
      return {
        name,
        status: 'fail',
        detail: `entry was captured with Lighthouse ${entry.lighthouseVersion}; installed Lighthouse is major ${currentLighthouseMajor}, so the baseline will be ignored`,
      };
    }

    return { name, status: 'pass', detail: key };
  });
}

function checkApiTargets(config: PulseConfig, baseline: BaselineFile): DoctorCheck[] {
  return resolveApiTargets(config).map((target) => {
    const key = apiBaselineKey(target.method, target.url);
    const name = `baseline api ${target.method} ${target.url}`;
    const entry = baseline.apiResults?.[key];

    if (!entry) {
      return { name, status: 'warn', detail: `no baseline entry for ${key}` };
    }
    if (entry.runs !== target.runs) {
      return {
        name,
        status: 'fail',
        detail: `entry has ${entry.runs} run${entry.runs === 1 ? '' : 's'}; config expects ${target.runs}`,
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
    status: !chrome.ok ? 'fail' : chrome.warning ? 'warn' : 'pass',
    detail: chrome.detail,
  });

  let config: PulseConfig | undefined;
  try {
    config = await loadConfig(options.configPath ?? '.pulse.json');
    const apiCount = config.api?.length ?? 0;
    checks.push({
      name: 'config',
      status: 'pass',
      detail: `${options.configPath ?? '.pulse.json'} (${config.urls.length} URL${
        config.urls.length === 1 ? '' : 's'
      }${apiCount > 0 ? `, ${apiCount} API endpoint${apiCount === 1 ? '' : 's'}` : ''})`,
    });
  } catch (error) {
    checks.push({ name: 'config', status: 'fail', detail: errorMessage(error) });
  }

  if (config) {
    const outDir = config.report.outDir;
    try {
      await mkdir(outDir, { recursive: true });
      checks.push({ name: 'report', status: 'pass', detail: `${outDir} is writable` });
    } catch (error) {
      checks.push({ name: 'report', status: 'fail', detail: `${outDir}: ${errorMessage(error)}` });
    }
  }

  const resolvedBaselinePath =
    options.baselinePath ?? (config ? baselinePath(config.report.outDir) : '.pulse/baseline.json');
  const inspected = await inspectBaseline(resolvedBaselinePath);
  checks.push(inspected.check);

  if (config && inspected.baseline) {
    checks.push(...checkTargets(config, inspected.baseline, installedLighthouseMajor()));
    checks.push(...checkApiTargets(config, inspected.baseline));
  }

  if (!options.skipNetwork && config) {
    const reachable = options.checkUrl ?? checkUrl;
    const apiReachable = options.checkApi ?? checkApiTarget;
    const pages = resolveTargets(config);
    const apiTargets = resolveApiTargets(config);

    // Doctor is diagnostic, so independent checks can run together. Promise.all
    // keeps the declared order in the results while overlapping the requests.
    const [pageChecks, apiChecks] = await Promise.all([
      Promise.all(
        pages.map(async (page): Promise<DoctorCheck> => {
          const url = targetUrl(page);
          const result = await reachable(url);
          return {
            name: `url ${url}`,
            status: result.ok ? 'pass' : 'fail',
            detail: result.detail,
          };
        }),
      ),
      Promise.all(
        apiTargets.map(async (target): Promise<DoctorCheck> => {
          const result = await apiReachable(target);
          return {
            name: `api ${target.method} ${target.url}`,
            status: result.ok ? 'pass' : 'fail',
            detail: result.detail,
          };
        }),
      ),
    ]);

    checks.push(...pageChecks, ...apiChecks);
  }

  return { ok: !checks.some((check) => check.status === 'fail'), checks };
}
