export * from './types.js';
export {
  budgetsFromResult,
  configSchema,
  defaultConfig,
  loadConfig,
  PulseConfigError,
  resolvePageConfig,
  resolveTargets,
  writeConfig,
} from './config.js';
export { runAudit, pickMedianRun } from './runner.js';
export type { AuditOptions } from './runner.js';
export { findChromeBinary, isWsl, linuxChromeCandidates } from './chrome.js';
export type { ChromeLookup, ChromeLookupOptions } from './chrome.js';
export { extractResult, worstImpact, isA11yImpact } from './extract.js';
export {
  compareResult,
  countNewViolations,
  countNewViolationsByImpact,
  countViolationNodes,
  countViolationNodesByImpact,
  filterIgnoredViolations,
  violationKey,
} from './compare.js';
export { buildReport, reportEntry, REPORT_VERSION } from './report.js';
export type { ReportInput } from './report.js';
export {
  BASELINE_VERSION,
  baselineKey,
  baselinePath,
  comparableBaseline,
  mergeBaseline,
  pruneBaseline,
  readBaseline,
  writeBaseline,
} from './baseline.js';
export { printReport, spreadParts } from './reporters/terminal.js';
export { writeJsonReport } from './reporters/json.js';
export { renderHtml, writeHtmlReport } from './reporters/html.js';
export { renderMarkdown, upsertSummary } from './reporters/summary.js';
export { formatBytes, formatDelta, formatPercent, formatValue } from './format.js';
export { AUDIT_METRIC_KEYS, metricSpreads, metricStat } from './util/variance.js';
export type { AuditMetricKey, MetricStat } from './util/variance.js';
export { runDoctor } from './doctor.js';
export type { DoctorCheck, DoctorOptions, DoctorResult, DoctorStatus } from './doctor.js';
export { VERSION } from './version.js';
export { parseBytes, parseCount, parseDuration, parsePercent, parseScore } from './util/units.js';
