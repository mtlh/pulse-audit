import { join } from 'node:path';
import type { PulseReport } from '../types.js';
import { writeJsonFile } from '../util/files.js';

export async function writeJsonReport(report: PulseReport, outDir: string): Promise<string> {
  const path = join(outDir, 'report.json');
  await writeJsonFile(path, report);
  return path;
}
