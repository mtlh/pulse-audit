import { compareResult, countViolationNodes, filterIgnoredViolations } from './compare.js';
import type { AuditResult, Preset, PulseConfig, PulseReport, ReportEntry } from './types.js';

// v2 adds the expanded metric set, per-run samples and third-party details.
export const REPORT_VERSION = '2';

export interface ReportInput {
  result: AuditResult;
  baseline: AuditResult | null;
  config: PulseConfig;
}

/**
 * Builds one report entry. Ignored axe rules are removed from both halves of the
 * comparison here so the displayed audit, the checks and the aggregate counts
 * can never disagree.
 */
export function reportEntry(input: ReportInput): ReportEntry {
  const ignoreRules = input.config.budgets.a11y?.ignoreRules;
  const audit = filterIgnoredViolations(input.result, ignoreRules);
  const baseline = input.baseline ? filterIgnoredViolations(input.baseline, ignoreRules) : null;

  const entry: ReportEntry = {
    url: audit.url,
    audit,
    baseline,
    checks: compareResult(audit, baseline, input.config),
  };

  if (ignoreRules && ignoreRules.length > 0) {
    const ignored = input.result.violations.filter((violation) => ignoreRules.includes(violation.id));
    entry.ignoredRules = [...ignoreRules];
    entry.ignoredViolations = countViolationNodes({ violations: ignored });
  }

  return entry;
}

export function buildReport(inputs: ReportInput[]): PulseReport {
  const entries = inputs.map(reportEntry);
  const checks = entries.flatMap((entry) => entry.checks);

  const presets: Preset[] = [];
  for (const entry of entries) {
    if (!presets.includes(entry.audit.preset)) presets.push(entry.audit.preset);
  }

  return {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    preset: presets[0] ?? inputs[0]?.config.preset ?? 'mobile',
    presets,
    runs: entries.reduce((max, entry) => Math.max(max, entry.audit.runs), 0),
    results: entries,
    failed: checks.filter((check) => check.status === 'fail').length,
    warned: checks.filter((check) => check.status === 'warn').length,
    passed: checks.filter((check) => check.status === 'pass').length,
  };
}
