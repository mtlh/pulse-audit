import { formatDelta, formatPercent, formatValue, type ValueFormat } from './format.js';
import type { AuditMetrics, AuditResult, Check, PulseConfig, Severity, Status } from './types.js';

interface MetricSpec {
  key: Exclude<keyof AuditMetrics, 'violations'>;
  label: string;
  format: ValueFormat;
  defaultSeverity: Severity;
}

const METRIC_SPECS: MetricSpec[] = [
  { key: 'lcp', label: 'LCP', format: 'ms', defaultSeverity: 'error' },
  { key: 'cls', label: 'CLS', format: 'score', defaultSeverity: 'error' },
  { key: 'tbt', label: 'TBT', format: 'ms', defaultSeverity: 'warn' },
  { key: 'js', label: 'JavaScript', format: 'bytes', defaultSeverity: 'error' },
  { key: 'images', label: 'Images', format: 'bytes', defaultSeverity: 'warn' },
  { key: 'requests', label: 'Requests', format: 'count', defaultSeverity: 'error' },
];

export function countViolationNodes(result: AuditResult): number {
  return result.violations.reduce((total, violation) => total + Math.max(violation.nodes.length, 1), 0);
}

/**
 * Counts violation nodes that are not in the baseline, keyed by rule id + selector.
 * Refine to include failureSummary if selectors prove too coarse in practice.
 */
export function countNewViolations(current: AuditResult, baseline: AuditResult | null): number {
  if (!baseline) return countViolationNodes(current);

  const known = new Set<string>();
  for (const violation of baseline.violations) {
    const selectors = violation.nodes.length > 0 ? violation.nodes.map((node) => node.selector) : [''];
    for (const selector of selectors) known.add(`${violation.id}::${selector}`);
  }

  let count = 0;
  for (const violation of current.violations) {
    const selectors = violation.nodes.length > 0 ? violation.nodes.map((node) => node.selector) : [''];
    for (const selector of selectors) {
      if (!known.has(`${violation.id}::${selector}`)) count += 1;
    }
  }
  return count;
}

function evaluateMetric(
  metric: MetricSpec,
  current: AuditResult,
  baseline: AuditResult | null,
  config: PulseConfig,
): Check | null {
  const rule = config.budgets[metric.key];
  if (!rule || (rule.max === undefined && rule.regression === undefined)) return null;

  const value = current.metrics[metric.key];
  const baselineValue = baseline?.metrics[metric.key];
  const delta = baselineValue === undefined ? undefined : value - baselineValue;
  const deltaPct =
    baselineValue !== undefined && baselineValue > 0 && delta !== undefined
      ? (delta / baselineValue) * 100
      : undefined;

  const absoluteBreach = rule.max !== undefined && value > rule.max;
  const regressionBreach =
    rule.regression !== undefined && deltaPct !== undefined && deltaPct > rule.regression;
  const severity = rule.severity ?? metric.defaultSeverity;

  let status: Status = 'pass';
  let reason = 'within budget';

  if (absoluteBreach || regressionBreach) {
    if (absoluteBreach && !regressionBreach && baseline && severity === 'error') {
      // Ratchet behaviour: already over budget before this change. Do not block
      // the PR, but the report still makes the overshoot visible. Warnings stay
      // warnings so noisy metrics remain visible without failing the build.
      status = 'pass';
      reason = `over max ${formatValue(rule.max!, metric.format)} but not a regression`;
    } else {
      status = severity === 'warn' ? 'warn' : 'fail';
      const causes: string[] = [];
      if (absoluteBreach) causes.push(`over max ${formatValue(rule.max!, metric.format)}`);
      if (regressionBreach) causes.push(`regressed ${formatPercent(deltaPct)} vs baseline`);
      reason = causes.join(' and ');
    }
  }

  return {
    metric: metric.key,
    label: metric.label,
    value,
    formatted: formatValue(value, metric.format),
    format: metric.format,
    baseline: baselineValue,
    baselineFormatted: baselineValue === undefined ? undefined : formatValue(baselineValue, metric.format),
    max: rule.max,
    delta,
    deltaPct,
    status,
    severity,
    reason: `${reason}${delta !== undefined ? ` (${formatDelta(delta, metric.format)})` : ''}`,
  };
}

function evaluateA11y(
  current: AuditResult,
  baseline: AuditResult | null,
  config: PulseConfig,
): Check[] {
  const rule = config.budgets.a11y;
  if (!rule) return [];

  const severity = rule.severity ?? 'error';
  const total = countViolationNodes(current);
  const checks: Check[] = [];

  if (rule.maxNew !== undefined) {
    // Without a baseline nothing can be "new". Existing debt is recorded via
    // maxViolations; gating on maxNew starts with the first saved baseline.
    const hasBaseline = baseline !== null;
    const newViolations = hasBaseline ? countNewViolations(current, baseline) : 0;
    const failed = hasBaseline && newViolations > rule.maxNew;
    checks.push({
      metric: 'a11yNew',
      label: 'New a11y violations',
      value: newViolations,
      formatted: String(newViolations),
      format: 'count',
      max: rule.maxNew,
      status: failed ? (severity === 'warn' ? 'warn' : 'fail') : 'pass',
      severity,
      reason: !hasBaseline
        ? 'no baseline yet; existing violations are recorded but not gated'
        : failed
          ? `max ${rule.maxNew} new violations`
          : 'no new violations',
    });
  }

  if (rule.maxViolations !== undefined) {
    const failed = total > rule.maxViolations;
    checks.push({
      metric: 'a11yTotal',
      label: 'Total a11y violations',
      value: total,
      formatted: String(total),
      format: 'count',
      max: rule.maxViolations,
      status: failed ? (severity === 'warn' ? 'warn' : 'fail') : 'pass',
      severity,
      reason: failed ? `max ${rule.maxViolations} total violations` : 'within budget',
    });
  }

  return checks;
}

export function compareResult(
  current: AuditResult,
  baseline: AuditResult | null,
  config: PulseConfig,
): Check[] {
  const metricChecks = METRIC_SPECS.map((metric) => evaluateMetric(metric, current, baseline, config)).filter(
    (check): check is Check => check !== null,
  );

  return [...metricChecks, ...evaluateA11y(current, baseline, config)];
}
