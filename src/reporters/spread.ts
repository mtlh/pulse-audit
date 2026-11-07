import { formatRange } from '../format.js';
import type { ApiMetricKey, ApiReportEntry, AuditMetrics, Check, ReportEntry } from '../types.js';
import { metricSpreads, metricStat, type MetricStat } from '../util/variance.js';

export interface SpreadRow {
  check: Check;
  stat: MetricStat;
}

/**
 * Min/max detail for every checked metric that actually varied between the
 * measured runs. Shared by the terminal, Markdown and HTML reporters so they
 * cannot disagree about which metrics had a spread.
 */
export function spreadRows(entry: ReportEntry): SpreadRow[] {
  const samples = entry.audit.samples;
  if (!samples || samples.length < 2) return [];

  const spreads = metricSpreads(samples);
  const rows: SpreadRow[] = [];
  for (const check of entry.checks) {
    const stat = spreads[check.metric as keyof AuditMetrics];
    if (!stat || stat.max === stat.min) continue;
    rows.push({ check, stat });
  }
  return rows;
}

/** Compact `LCP 1.48–1.61s` fragments for the one-line spread summaries. */
export function spreadParts(entry: ReportEntry): string[] {
  return spreadRows(entry).map(
    ({ check, stat }) => `${check.label} ${formatRange(stat.min, stat.max, check.format)}`,
  );
}

const API_SPREAD_KEYS: ApiMetricKey[] = ['ttfb', 'duration', 'bytes'];

export function apiSpreadRows(entry: ApiReportEntry): SpreadRow[] {
  const samples = entry.result.samples;
  if (!samples || samples.length < 2) return [];

  const rows: SpreadRow[] = [];
  for (const check of entry.checks) {
    if (!API_SPREAD_KEYS.includes(check.metric as ApiMetricKey)) continue;
    const key = check.metric as ApiMetricKey;
    const stat = metricStat(samples.map((sample) => sample[key]));
    if (stat.max === stat.min) continue;
    rows.push({ check, stat });
  }
  return rows;
}

export function apiSpreadParts(entry: ApiReportEntry): string[] {
  return apiSpreadRows(entry).map(
    ({ check, stat }) => `${check.label} ${formatRange(stat.min, stat.max, check.format)}`,
  );
}
