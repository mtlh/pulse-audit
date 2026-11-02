import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditResult, BaselineFile } from './types.js';

export function baselinePath(outDir: string): string {
  return `${outDir}/baseline.json`;
}

export async function readBaseline(path: string): Promise<BaselineFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as BaselineFile;
    if (parsed.version !== 1 || typeof parsed.results !== 'object' || parsed.results === null) {
      throw new Error(`Unsupported baseline format in ${path}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, results: {} };
    }
    throw error;
  }
}

export async function writeBaseline(path: string, file: BaselineFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/**
 * A baseline from a different preset, run count or Lighthouse version is not
 * comparable. Return null instead of producing a misleading delta.
 */
export function comparableBaseline(
  baseline: AuditResult | undefined,
  current: AuditResult,
): AuditResult | null {
  if (!baseline) return null;
  if (baseline.preset !== current.preset) return null;
  if (baseline.runs !== current.runs) return null;
  if (baseline.lighthouseVersion && current.lighthouseVersion) {
    if (baseline.lighthouseVersion !== current.lighthouseVersion) return null;
  }
  return baseline;
}

export function mergeBaseline(file: BaselineFile, results: AuditResult[]): BaselineFile {
  const next: BaselineFile = { version: 1, results: { ...file.results } };
  for (const result of results) next.results[result.url] = result;
  return next;
}
