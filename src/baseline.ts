import type { ApiResult, AuditResult, BaselineFile, HttpMethod, Preset } from './types.js';
import { isEnoent } from './util/errors.js';
import { readJsonFile, writeJsonFile } from './util/files.js';
import { isRecord } from './util/guards.js';

export const BASELINE_VERSION = 3 as const;

export function baselinePath(outDir: string): string {
  return `${outDir}/baseline.json`;
}

export function baselineKey(preset: Preset, url: string): string {
  return `${preset}::${url}`;
}

export function apiBaselineKey(method: HttpMethod, url: string): string {
  return `api::${method}::${url}`;
}

function migrateV1(results: Record<string, unknown>): BaselineFile {
  const migrated: Record<string, AuditResult> = {};

  for (const [key, value] of Object.entries(results)) {
    if (!isRecord(value)) {
      throw new Error(`Unsupported baseline result for ${key}`);
    }

    const result = value as unknown as AuditResult;
    const preset: Preset = result.preset === 'desktop' ? 'desktop' : 'mobile';
    const url = typeof result.url === 'string' ? result.url : key;
    migrated[baselineKey(preset, url)] = result;
  }

  return { version: BASELINE_VERSION, results: migrated, apiResults: {} };
}

export async function readBaseline(path: string): Promise<BaselineFile> {
  try {
    const parsed: unknown = await readJsonFile(path);
    if (!isRecord(parsed) || !isRecord(parsed.results)) {
      throw new Error(`Unsupported baseline format in ${path}`);
    }

    if (parsed.version === 1) return migrateV1(parsed.results);
    if (parsed.version === 2) {
      // v2 had no API results; keep its page entries and start the API side empty.
      return {
        version: BASELINE_VERSION,
        results: parsed.results as Record<string, AuditResult>,
        apiResults: {},
      };
    }
    if (parsed.version === 3) {
      const apiResults = isRecord(parsed.apiResults) ? (parsed.apiResults as Record<string, ApiResult>) : {};
      return {
        version: BASELINE_VERSION,
        results: parsed.results as Record<string, AuditResult>,
        apiResults,
      };
    }

    throw new Error(`Unsupported baseline format in ${path}`);
  } catch (error) {
    if (isEnoent(error)) {
      return { version: BASELINE_VERSION, results: {}, apiResults: {} };
    }
    throw error;
  }
}

export async function writeBaseline(path: string, file: BaselineFile): Promise<void> {
  const next: BaselineFile = { version: BASELINE_VERSION, results: file.results };
  if (file.apiResults && Object.keys(file.apiResults).length > 0) {
    next.apiResults = file.apiResults;
  }
  await writeJsonFile(path, next);
}

export function lighthouseMajor(version: string | undefined): number | null {
  if (!version) return null;
  const match = /^v?(\d+)/i.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

/**
 * A baseline from a different preset, run count or Lighthouse major version is
 * not comparable. Return null instead of producing a misleading delta.
 */
export function comparableBaseline(
  baseline: AuditResult | undefined,
  current: AuditResult,
): AuditResult | null {
  if (!baseline) return null;
  if (baseline.preset !== current.preset) return null;
  if (baseline.runs !== current.runs) return null;

  const baselineMajor = lighthouseMajor(baseline.lighthouseVersion);
  const currentMajor = lighthouseMajor(current.lighthouseVersion);
  if (baselineMajor !== null && currentMajor !== null && baselineMajor !== currentMajor) {
    return null;
  }

  return baseline;
}

/**
 * An API baseline is comparable only when the method and measured run count
 * match. Status and size are reported but do not participate in comparability.
 */
export function comparableApiBaseline(baseline: ApiResult | undefined, current: ApiResult): ApiResult | null {
  if (!baseline) return null;
  if (baseline.method !== current.method) return null;
  if (baseline.runs !== current.runs) return null;
  return baseline;
}

export function mergeBaseline(
  file: BaselineFile,
  results: AuditResult[],
  apiResults: ApiResult[] = [],
): BaselineFile {
  const next: BaselineFile = { version: BASELINE_VERSION, results: { ...file.results } };
  for (const result of results) {
    next.results[baselineKey(result.preset, result.url)] = result;
  }

  const api = { ...(file.apiResults ?? {}) };
  for (const result of apiResults) {
    api[apiBaselineKey(result.method, result.url)] = result;
  }
  if (Object.keys(api).length > 0) next.apiResults = api;

  return next;
}

/**
 * Return a new baseline containing only the requested keys. When
 * `keepApiKeys` is omitted, API entries are preserved: callers that only know
 * about UI targets cannot accidentally drop API history.
 */
export function pruneBaseline(
  file: BaselineFile,
  keepKeys: Set<string>,
  keepApiKeys?: Set<string>,
): BaselineFile {
  const results: Record<string, AuditResult> = {};
  for (const [key, result] of Object.entries(file.results)) {
    if (keepKeys.has(key)) results[key] = result;
  }

  const next: BaselineFile = { version: BASELINE_VERSION, results };
  if (file.apiResults) {
    const apiResults: Record<string, ApiResult> = {};
    for (const [key, result] of Object.entries(file.apiResults)) {
      if (!keepApiKeys || keepApiKeys.has(key)) apiResults[key] = result;
    }
    if (Object.keys(apiResults).length > 0) next.apiResults = apiResults;
  }

  return next;
}
