import type { AuditMetrics } from '../types.js';
import { median } from './median.js';

/**
 * Every numeric metric, in report order. Kept as a tuple so reporters and the
 * runner can iterate it without open-coding the metric names again.
 */
export const AUDIT_METRIC_KEYS = [
  'lcp',
  'cls',
  'tbt',
  'fcp',
  'ttfb',
  'js',
  'css',
  'fonts',
  'images',
  'total',
  'requests',
  'thirdPartyBytes',
  'thirdPartyRequests',
  'violations',
] as const satisfies readonly (keyof AuditMetrics)[];

export type AuditMetricKey = (typeof AUDIT_METRIC_KEYS)[number];

export interface MetricStat {
  min: number;
  median: number;
  max: number;
  /** Peak-to-peak spread as a percentage of the median. 0 when the median is 0. */
  spreadPct: number;
}

export function metricStat(values: number[]): MetricStat {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { min: 0, median: 0, max: 0, spreadPct: 0 };

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const middle = median(finite);

  return {
    min,
    median: middle,
    max,
    spreadPct: middle === 0 ? 0 : ((max - min) / middle) * 100,
  };
}

/** Per-metric min/median/max/spread for a set of measured runs. */
export function metricSpreads(samples: AuditMetrics[]): Partial<Record<keyof AuditMetrics, MetricStat>> {
  const spreads: Partial<Record<keyof AuditMetrics, MetricStat>> = {};
  for (const key of AUDIT_METRIC_KEYS) {
    spreads[key] = metricStat(samples.map((sample) => sample[key]));
  }
  return spreads;
}
