import type { ValueFormat } from './format.js';
import type { ApiMetricKey, AuditMetrics, BudgetRule, BudgetSet, Severity } from './types.js';
import { parseBytes, parseCount, parseDuration, parseScore } from './util/units.js';

/**
 * The metric registry is the single source of truth for every measured value.
 *
 * Budget validation, comparison labels, the `init` table, run variance and the
 * cheap pre-check all derive from these definitions, so a metric can never be
 * spelled, formatted or classified differently in two places. Add a metric
 * here first, then extend `AuditMetrics` in types.ts.
 */

export type UnitParser = (value: unknown) => unknown;

/** How the cheap pre-check can treat a metric. */
export type FastStrategy = 'size' | 'timing';

export interface MetricDefinition<K extends string = string> {
  key: K;
  label: string;
  format: ValueFormat;
  /** Used when a budget rule does not override severity. */
  defaultSeverity: Severity;
  /** Reads a human-readable config unit, for example `"2.5s"` or `"250kb"`. */
  parse: UnitParser;
  /** `size` is measurable from network events; `timing` needs Lighthouse. */
  fast: FastStrategy;
}

export type BudgetMetricKey = Exclude<keyof BudgetSet, 'a11y'>;
export type ApiBudgetMetricKey = ApiMetricKey;

const definition = <K extends string>(metric: MetricDefinition<K>): MetricDefinition<K> => metric;

/** Page metrics that can carry a budget, in report order. */
export const AUDIT_METRICS = [
  definition({
    key: 'lcp',
    label: 'LCP',
    format: 'ms',
    defaultSeverity: 'error',
    parse: parseDuration,
    fast: 'timing',
  }),
  definition({
    key: 'cls',
    label: 'CLS',
    format: 'score',
    defaultSeverity: 'error',
    parse: parseScore,
    fast: 'timing',
  }),
  definition({
    key: 'tbt',
    label: 'TBT',
    format: 'ms',
    defaultSeverity: 'warn',
    parse: parseDuration,
    fast: 'timing',
  }),
  definition({
    key: 'fcp',
    label: 'FCP',
    format: 'ms',
    defaultSeverity: 'error',
    parse: parseDuration,
    fast: 'timing',
  }),
  definition({
    key: 'ttfb',
    label: 'TTFB',
    format: 'ms',
    defaultSeverity: 'warn',
    parse: parseDuration,
    fast: 'timing',
  }),
  definition({
    key: 'js',
    label: 'JavaScript',
    format: 'bytes',
    defaultSeverity: 'error',
    parse: parseBytes,
    fast: 'size',
  }),
  definition({
    key: 'css',
    label: 'CSS',
    format: 'bytes',
    defaultSeverity: 'warn',
    parse: parseBytes,
    fast: 'size',
  }),
  definition({
    key: 'fonts',
    label: 'Fonts',
    format: 'bytes',
    defaultSeverity: 'warn',
    parse: parseBytes,
    fast: 'size',
  }),
  definition({
    key: 'images',
    label: 'Images',
    format: 'bytes',
    defaultSeverity: 'warn',
    parse: parseBytes,
    fast: 'size',
  }),
  definition({
    key: 'total',
    label: 'Total weight',
    format: 'bytes',
    defaultSeverity: 'warn',
    parse: parseBytes,
    fast: 'size',
  }),
  definition({
    key: 'requests',
    label: 'Requests',
    format: 'count',
    defaultSeverity: 'error',
    parse: parseCount,
    fast: 'size',
  }),
  definition({
    key: 'failedRequests',
    label: 'Failed requests',
    format: 'count',
    defaultSeverity: 'error',
    parse: parseCount,
    fast: 'timing',
  }),
  definition({
    key: 'thirdPartyBytes',
    label: 'Third-party bytes',
    format: 'bytes',
    defaultSeverity: 'warn',
    parse: parseBytes,
    fast: 'size',
  }),
  definition({
    key: 'thirdPartyRequests',
    label: 'Third-party requests',
    format: 'count',
    defaultSeverity: 'warn',
    parse: parseCount,
    fast: 'size',
  }),
  definition({
    key: 'longTasks',
    label: 'Long tasks',
    format: 'count',
    defaultSeverity: 'warn',
    parse: parseCount,
    fast: 'timing',
  }),
  definition({
    key: 'thirdPartyMainThread',
    label: 'Third-party main thread',
    format: 'ms',
    defaultSeverity: 'warn',
    parse: parseDuration,
    fast: 'timing',
  }),
  definition({
    key: 'consoleErrors',
    label: 'Console errors',
    format: 'count',
    defaultSeverity: 'error',
    parse: parseCount,
    fast: 'timing',
  }),
] as const satisfies readonly MetricDefinition<BudgetMetricKey>[];

export type AuditMetricDefinition = (typeof AUDIT_METRICS)[number];
export type AuditMetricDefinitionKey = AuditMetricDefinition['key'];

/** The accessibility node count is reported like a metric but gated separately. */
export const A11Y_METRIC_LABEL = 'A11y nodes';

/** Every numeric page metric, in report order. */
export const AUDIT_METRIC_KEYS = [...AUDIT_METRICS.map((metric) => metric.key), 'violations'] as const;
export type AuditMetricKey = (typeof AUDIT_METRIC_KEYS)[number];

/** Page metrics the cheap pre-check can measure from network events. */
export const FAST_SIZE_METRICS = AUDIT_METRICS.filter((metric) => metric.fast === 'size').map(
  (metric) => metric.key,
);

/** Page metrics that only a full Lighthouse run can measure comparably. */
export const FAST_TIMING_METRICS = AUDIT_METRICS.filter((metric) => metric.fast === 'timing').map(
  (metric) => metric.key,
);

/** API metrics, in report order. They share the metric definition shape. */
export const API_METRICS = [
  definition({
    key: 'ttfb',
    label: 'TTFB',
    format: 'ms',
    defaultSeverity: 'error',
    parse: parseDuration,
    fast: 'timing',
  }),
  definition({
    key: 'duration',
    label: 'Duration',
    format: 'ms',
    defaultSeverity: 'error',
    parse: parseDuration,
    fast: 'timing',
  }),
  definition({
    key: 'bytes',
    label: 'Response size',
    format: 'bytes',
    defaultSeverity: 'error',
    parse: parseBytes,
    fast: 'size',
  }),
] as const satisfies readonly MetricDefinition<ApiBudgetMetricKey>[];

export type ApiMetricDefinition = (typeof API_METRICS)[number];

/** Builds a complete page metric set, defaulting every value to zero. */
export function auditMetrics(overrides: Partial<AuditMetrics> = {}): AuditMetrics {
  const metrics = {} as AuditMetrics;
  for (const key of AUDIT_METRIC_KEYS) metrics[key] = 0;
  return Object.assign(metrics, overrides);
}

/** A budget rule only participates when it sets a ceiling or a regression. */
export function budgetRuleConfigured(rule: BudgetRule | undefined): rule is BudgetRule {
  return rule !== undefined && (rule.max !== undefined || rule.regression !== undefined);
}

export function findAuditMetric(key: string): AuditMetricDefinition | undefined {
  return AUDIT_METRICS.find((metric) => metric.key === key);
}

export function findApiMetric(key: string): ApiMetricDefinition | undefined {
  return API_METRICS.find((metric) => metric.key === key);
}
