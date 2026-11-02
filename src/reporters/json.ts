import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PulseReport } from '../types.js';

export async function writeJsonReport(report: PulseReport, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, 'report.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}
