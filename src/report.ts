import { compareResult } from './compare.js';
import type { AuditResult, PulseConfig, PulseReport, ReportEntry } from './types.js';

export const REPORT_VERSION = '1';

export function buildReport(
  results: AuditResult[],
  baselines: Record<string, AuditResult | null>,
  config: PulseConfig,
): PulseReport {
  const entries: ReportEntry[] = results.map((audit) => {
    const baseline = baselines[audit.url] ?? null;
    return {
      url: audit.url,
      audit,
      baseline,
      checks: compareResult(audit, baseline, config),
    };
  });

  const checks = entries.flatMap((entry) => entry.checks);

  return {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    preset: config.preset,
    runs: config.runs,
    results: entries,
    failed: checks.filter((check) => check.status === 'fail').length,
    warned: checks.filter((check) => check.status === 'warn').length,
    passed: checks.filter((check) => check.status === 'pass').length,
  };
}
