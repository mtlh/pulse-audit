import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditResult, BaselineFile, Preset } from './types.js';

export const BASELINE_VERSION = 2 as const;

export function baselinePath(outDir: string): string {
  return `${outDir}/baseline.json`;
}

export function baselineKey(preset: Preset, url: string): string {
  return `${preset}::${url}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  return { version: BASELINE_VERSION, results: migrated };
}

export async function readBaseline(path: string): Promise<BaselineFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.results)) {
      throw new Error(`Unsupported baseline format in ${path}`);
    }

    if (parsed.version === 1) return migrateV1(parsed.results);
    if (parsed.version === 2) {
      return {
        version: BASELINE_VERSION,
        results: parsed.results as Record<string, AuditResult>,
      };
    }

    throw new Error(`Unsupported baseline format in ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: BASELINE_VERSION, results: {} };
    }
    throw error;
  }
}

export async function writeBaseline(path: string, file: BaselineFile): Promise<void> {
  const next: BaselineFile = { version: BASELINE_VERSION, results: file.results };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function lighthouseMajor(version: string | undefined): number | null {
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

export function mergeBaseline(file: BaselineFile, results: AuditResult[]): BaselineFile {
  const next: BaselineFile = { version: BASELINE_VERSION, results: { ...file.results } };
  for (const result of results) {
    next.results[baselineKey(result.preset, result.url)] = result;
  }
  return next;
}

/** Return a new baseline containing only the requested keys. */
export function pruneBaseline(file: BaselineFile, keepKeys: Set<string>): BaselineFile {
  const results: Record<string, AuditResult> = {};
  for (const [key, result] of Object.entries(file.results)) {
    if (keepKeys.has(key)) results[key] = result;
  }
  return { version: BASELINE_VERSION, results };
}
