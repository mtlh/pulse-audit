import { compareApiResult, compareResult, countViolationNodes, filterIgnoredViolations } from './compare.js';
import type {
  ApiBudgetSet,
  ApiReportEntry,
  ApiResult,
  AuditMethod,
  AuditResult,
  Preset,
  PulseConfig,
  PulseReport,
  ReportEntry,
} from './types.js';

// v4 adds the audit method and the budgets a fast pre-check actually enforced.
export const REPORT_VERSION = '4';

export interface ReportInput {
  result: AuditResult;
  baseline: AuditResult | null;
  config: PulseConfig;
  /** Defaults to `lighthouse` for callers that predate the cheap pre-check. */
  method?: AuditMethod;
  enforcedBudgets?: string[];
}

export interface ApiReportInput {
  result: ApiResult;
  baseline: ApiResult | null;
  budgets: ApiBudgetSet;
  strict?: boolean;
  expectStatus?: number | number[];
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
    method: input.method ?? 'lighthouse',
  };

  if (input.enforcedBudgets && input.enforcedBudgets.length > 0) {
    entry.enforcedBudgets = input.enforcedBudgets;
  }

  if (ignoreRules && ignoreRules.length > 0) {
    const ignored = input.result.violations.filter((violation) => ignoreRules.includes(violation.id));
    entry.ignoredRules = [...new Set(ignoreRules)];
    entry.ignoredViolations = countViolationNodes({ violations: ignored });
  }

  return entry;
}

export function apiReportEntry(input: ApiReportInput): ApiReportEntry {
  return {
    url: input.result.url,
    method: input.result.method,
    result: input.result,
    baseline: input.baseline,
    checks: compareApiResult(input.result, input.baseline, {
      budgets: input.budgets,
      strict: input.strict,
      expectStatus: input.expectStatus,
    }),
  };
}

export function buildReport(inputs: ReportInput[], apiInputs: ApiReportInput[] = []): PulseReport {
  const entries = inputs.map(reportEntry);
  const apiResults = apiInputs.map(apiReportEntry);
  const checks = [
    ...entries.flatMap((entry) => entry.checks),
    ...apiResults.flatMap((entry) => entry.checks),
  ];

  const presets: Preset[] = [];
  for (const entry of entries) {
    if (!presets.includes(entry.audit.preset)) presets.push(entry.audit.preset);
  }

  const uiRuns = entries.reduce((max, entry) => Math.max(max, entry.audit.runs), 0);
  const apiRuns = apiResults.reduce((max, entry) => Math.max(max, entry.result.runs), 0);

  const report: PulseReport = {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    preset: presets[0] ?? inputs[0]?.config.preset ?? 'mobile',
    presets,
    runs: Math.max(uiRuns, apiRuns),
    results: entries,
    failed: checks.filter((check) => check.status === 'fail').length,
    warned: checks.filter((check) => check.status === 'warn').length,
    passed: checks.filter((check) => check.status === 'pass').length,
  };

  if (apiResults.length > 0) report.apiResults = apiResults;
  return report;
}
