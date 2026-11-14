import { formatDelta, formatPercent, formatValue, type ValueFormat } from './format.js';
import type {
  A11yImpact,
  A11yNode,
  A11yViolation,
  ApiBudgetSet,
  ApiMetricKey,
  ApiResult,
  AuditMetrics,
  AuditResult,
  BudgetRule,
  Check,
  PulseConfig,
  Severity,
  Status,
} from './types.js';
import { IMPACT_ORDER } from './util/a11y.js';

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
  { key: 'fcp', label: 'FCP', format: 'ms', defaultSeverity: 'error' },
  { key: 'ttfb', label: 'TTFB', format: 'ms', defaultSeverity: 'warn' },
  { key: 'js', label: 'JavaScript', format: 'bytes', defaultSeverity: 'error' },
  { key: 'css', label: 'CSS', format: 'bytes', defaultSeverity: 'warn' },
  { key: 'fonts', label: 'Fonts', format: 'bytes', defaultSeverity: 'warn' },
  { key: 'images', label: 'Images', format: 'bytes', defaultSeverity: 'warn' },
  { key: 'total', label: 'Total weight', format: 'bytes', defaultSeverity: 'warn' },
  { key: 'requests', label: 'Requests', format: 'count', defaultSeverity: 'error' },
  { key: 'thirdPartyBytes', label: 'Third-party bytes', format: 'bytes', defaultSeverity: 'warn' },
  { key: 'thirdPartyRequests', label: 'Third-party requests', format: 'count', defaultSeverity: 'warn' },
  { key: 'longTasks', label: 'Long tasks', format: 'count', defaultSeverity: 'warn' },
];

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Stable identity for an a11y node across runs. Rule id alone is too coarse and
 * a selector alone can appear twice on one page with different remedies, so the
 * failure summary is part of the key. Whitespace differences are ignored.
 */
export function violationKey(id: string, selector: string, failureSummary?: string): string {
  return `${id}::${selector}::${normalizeText(failureSummary)}`;
}

function violationNodeKeys(violation: A11yViolation): string[] {
  if (violation.nodes.length === 0) return [violationKey(violation.id, '')];
  return violation.nodes.map((node) => violationKey(violation.id, node.selector, node.failureSummary));
}

interface KnownNodes {
  /** Full identity for nodes whose baseline recorded a failure summary. */
  full: Set<string>;
  /** `id::selector` for baseline nodes that predate failure summaries. */
  baseWithoutSummary: Set<string>;
  /** `id::selector` for every baseline node, used when the current node has no summary. */
  allBase: Set<string>;
}

/**
 * Version 1 baselines stored only `rule id + selector`; current runs also store
 * `failureSummary`. Index both shapes so upgrading does not turn every existing
 * violation into "new" debt.
 */
function indexKnownViolations(baseline: Pick<AuditResult, 'violations'>): KnownNodes {
  const index: KnownNodes = {
    full: new Set(),
    baseWithoutSummary: new Set(),
    allBase: new Set(),
  };

  for (const violation of baseline.violations) {
    const nodes = violation.nodes.length > 0 ? violation.nodes : [{ selector: '' }];
    for (const node of nodes) {
      const base = `${violation.id}::${node.selector}`;
      index.allBase.add(base);
      if (node.failureSummary) {
        index.full.add(violationKey(violation.id, node.selector, node.failureSummary));
      } else {
        index.baseWithoutSummary.add(base);
      }
    }
  }

  return index;
}

function isKnownNode(
  index: KnownNodes,
  id: string,
  selector: string,
  failureSummary: string | undefined,
): boolean {
  const base = `${id}::${selector}`;
  if (!failureSummary) return index.allBase.has(base);
  return index.full.has(violationKey(id, selector, failureSummary)) || index.baseWithoutSummary.has(base);
}

function nodeImpact(node: A11yNode, violation: A11yViolation): A11yImpact {
  return node.impact ?? violation.impact;
}

export function countViolationNodes(result: Pick<AuditResult, 'violations'>): number {
  const keys = new Set<string>();
  for (const violation of result.violations) {
    for (const key of violationNodeKeys(violation)) keys.add(key);
  }
  return keys.size;
}

/**
 * Counts violation nodes that are not in the baseline. Without a baseline every
 * current node is new (the gate itself deliberately treats this as 0 debt).
 */
export function countNewViolations(
  current: Pick<AuditResult, 'violations'>,
  baseline: Pick<AuditResult, 'violations'> | null,
): number {
  if (!baseline) return countViolationNodes(current);

  const known = indexKnownViolations(baseline);
  const next = new Set<string>();
  for (const violation of current.violations) {
    if (violation.nodes.length === 0) {
      if (!isKnownNode(known, violation.id, '', undefined)) {
        next.add(violationKey(violation.id, ''));
      }
      continue;
    }
    for (const node of violation.nodes) {
      if (!isKnownNode(known, violation.id, node.selector, node.failureSummary)) {
        next.add(violationKey(violation.id, node.selector, node.failureSummary));
      }
    }
  }
  return next.size;
}

export function countViolationNodesByImpact(
  result: Pick<AuditResult, 'violations'>,
  impact: A11yImpact,
): number {
  const keys = new Set<string>();
  for (const violation of result.violations) {
    if (violation.nodes.length === 0) {
      if (violation.impact === impact) keys.add(violationKey(violation.id, ''));
      continue;
    }
    for (const node of violation.nodes) {
      if (nodeImpact(node, violation) === impact) {
        keys.add(violationKey(violation.id, node.selector, node.failureSummary));
      }
    }
  }
  return keys.size;
}

export function countNewViolationsByImpact(
  current: Pick<AuditResult, 'violations'>,
  baseline: Pick<AuditResult, 'violations'> | null,
  impact: A11yImpact,
): number {
  if (!baseline) return countViolationNodesByImpact(current, impact);

  const known = indexKnownViolations(baseline);
  const next = new Set<string>();
  for (const violation of current.violations) {
    if (violation.nodes.length === 0) {
      if (violation.impact === impact && !isKnownNode(known, violation.id, '', undefined)) {
        next.add(violationKey(violation.id, ''));
      }
      continue;
    }
    for (const node of violation.nodes) {
      if (nodeImpact(node, violation) !== impact) continue;
      if (!isKnownNode(known, violation.id, node.selector, node.failureSummary)) {
        next.add(violationKey(violation.id, node.selector, node.failureSummary));
      }
    }
  }
  return next.size;
}

/**
 * Removes ignored axe rules and recalculates the violation count so the report
 * and the gate stay in agreement.
 */
export function filterIgnoredViolations(audit: AuditResult, ignoreRules?: string[]): AuditResult {
  if (!ignoreRules || ignoreRules.length === 0) return audit;

  const ignored = new Set(ignoreRules);
  const violations = audit.violations.filter((violation) => !ignored.has(violation.id));

  return {
    ...audit,
    violations,
    metrics: {
      ...audit.metrics,
      violations: countViolationNodes({ violations }),
    },
  };
}

interface BudgetEvaluation {
  metric: string;
  label: string;
  value: number;
  baselineValue: number | undefined;
  rule: BudgetRule;
  format: ValueFormat;
  defaultSeverity: Severity;
  strict: boolean;
}

function evaluateBudget(input: BudgetEvaluation): Check {
  const { metric, label, value, baselineValue, rule, format, defaultSeverity, strict } = input;
  const delta = baselineValue === undefined ? undefined : value - baselineValue;
  const deltaPct =
    baselineValue !== undefined && baselineValue > 0 && delta !== undefined
      ? (delta / baselineValue) * 100
      : undefined;

  const absoluteBreach = rule.max !== undefined && value > rule.max;
  const regressionEvaluable = rule.regression !== undefined && deltaPct !== undefined;
  const regressionBreach =
    rule.regression !== undefined && deltaPct !== undefined && deltaPct > rule.regression;
  const severity = rule.severity ?? defaultSeverity;
  // In strict mode an absolute budget is a hard ceiling: being better than the
  // baseline does not excuse being over it. Warnings stay warnings.
  const strictAbsoluteBreach = strict && absoluteBreach && severity === 'error';
  // The ratchet only applies when the baseline actually recorded this metric and
  // the change can be expressed as a percentage. A v1 baseline (or a zero
  // baseline value) has no usable comparison, so it must behave like no baseline
  // instead of excusing an absolute breach.
  //
  // Without a regression tolerance there is no "within tolerance" excuse, so
  // inherited debt only ratchets through when the metric did not get worse.
  const improvedOrFlat = delta !== undefined && delta <= 0;
  const ratchetPass =
    absoluteBreach &&
    !regressionBreach &&
    baselineValue !== undefined &&
    deltaPct !== undefined &&
    severity === 'error' &&
    !strictAbsoluteBreach &&
    (regressionEvaluable || improvedOrFlat);
  let status: Status = 'pass';
  let reason =
    rule.max === undefined && !regressionEvaluable
      ? 'no comparable baseline; regression not evaluated'
      : 'within budget';

  if (absoluteBreach || regressionBreach) {
    if (ratchetPass) {
      // Ratchet behaviour: already over budget before this change. Do not block
      // the PR, but the report still makes the overshoot visible. Warnings stay
      // warnings so noisy metrics remain visible without failing the build.
      status = 'pass';
      reason = `over max ${formatValue(rule.max!, format)} but not a regression`;
    } else {
      status = severity === 'warn' ? 'warn' : 'fail';
      const causes: string[] = [];
      if (absoluteBreach) causes.push(`over max ${formatValue(rule.max!, format)}`);
      if (regressionBreach) causes.push(`regressed ${formatPercent(deltaPct)} vs baseline`);
      reason = causes.join(' and ');
    }
  }

  return {
    metric,
    label,
    value,
    formatted: formatValue(value, format),
    format,
    baseline: baselineValue,
    baselineFormatted: baselineValue === undefined ? undefined : formatValue(baselineValue, format),
    max: rule.max,
    delta,
    deltaPct,
    status,
    severity,
    reason: `${reason}${delta !== undefined ? ` (${formatDelta(delta, format)})` : ''}`,
  };
}

function evaluateMetric(
  metric: MetricSpec,
  current: AuditResult,
  baseline: AuditResult | null,
  config: PulseConfig,
): Check | null {
  const rule = config.budgets[metric.key];
  if (!rule || (rule.max === undefined && rule.regression === undefined)) return null;

  return evaluateBudget({
    metric: metric.key,
    label: metric.label,
    value: current.metrics[metric.key],
    baselineValue: baseline?.metrics?.[metric.key],
    rule,
    format: metric.format,
    defaultSeverity: metric.defaultSeverity,
    strict: config.strict === true,
  });
}

function evaluateA11y(current: AuditResult, baseline: AuditResult | null, config: PulseConfig): Check[] {
  const rule = config.budgets.a11y;
  if (!rule) return [];

  const severity = rule.severity ?? 'error';
  const total = countViolationNodes(current);
  const hasBaseline = baseline !== null;
  const checks: Check[] = [];

  if (rule.maxNew !== undefined) {
    // Without a baseline nothing can be "new". Existing debt is recorded via
    // maxViolations; gating on maxNew starts with the first saved baseline.
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

  for (const impact of IMPACT_ORDER) {
    const max = rule.maxNewByImpact?.[impact];
    if (max === undefined) continue;

    const newViolations = hasBaseline ? countNewViolationsByImpact(current, baseline, impact) : 0;
    const failed = hasBaseline && newViolations > max;
    checks.push({
      metric: `a11yNew:${impact}`,
      label: `New ${impact} a11y`,
      value: newViolations,
      formatted: String(newViolations),
      format: 'count',
      max,
      status: failed ? (severity === 'warn' ? 'warn' : 'fail') : 'pass',
      severity,
      reason: !hasBaseline
        ? 'no baseline yet; existing violations are recorded but not gated'
        : failed
          ? `max ${max} new ${impact} violations`
          : `no new ${impact} violations`,
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
  // buildReport also filters before calling this, but doing it here keeps direct
  // compareResult callers honest and the operation is idempotent.
  const ignoreRules = config.budgets.a11y?.ignoreRules;
  const filteredCurrent = filterIgnoredViolations(current, ignoreRules);
  const filteredBaseline = baseline ? filterIgnoredViolations(baseline, ignoreRules) : null;

  const metricChecks = METRIC_SPECS.map((metric) =>
    evaluateMetric(metric, filteredCurrent, filteredBaseline, config),
  ).filter((check): check is Check => check !== null);

  return [...metricChecks, ...evaluateA11y(filteredCurrent, filteredBaseline, config)];
}

const API_METRIC_SPECS: Array<{
  key: ApiMetricKey;
  label: string;
  format: ValueFormat;
  defaultSeverity: Severity;
}> = [
  { key: 'ttfb', label: 'TTFB', format: 'ms', defaultSeverity: 'error' },
  { key: 'duration', label: 'Duration', format: 'ms', defaultSeverity: 'error' },
  { key: 'bytes', label: 'Response size', format: 'bytes', defaultSeverity: 'error' },
];

export interface ApiCompareOptions {
  budgets: ApiBudgetSet;
  strict?: boolean;
  /** Exact status code or codes that count as success. Defaults to 2xx–3xx. */
  expectStatus?: number | number[];
}

export function expectedStatus(status: number, expectStatus?: number | number[]): boolean {
  if (expectStatus === undefined) return status >= 200 && status < 400;
  const allowed = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
  return allowed.includes(status);
}

function evaluateApiStatus(
  current: ApiResult,
  baseline: ApiResult | null,
  expectStatus: number | number[] | undefined,
): Check {
  const status = current.metrics.status;
  const ok = expectedStatus(status, expectStatus);
  const explicit = expectStatus !== undefined;
  const expectedText = explicit
    ? Array.isArray(expectStatus)
      ? expectStatus.join(', ')
      : String(expectStatus)
    : '2xx–3xx';

  return {
    metric: 'status',
    label: 'HTTP status',
    value: status,
    formatted: String(status),
    format: 'count',
    baseline: baseline?.metrics.status,
    baselineFormatted: baseline ? String(baseline.metrics.status) : undefined,
    status: ok ? 'pass' : explicit ? 'fail' : 'warn',
    severity: explicit ? 'error' : 'warn',
    reason: ok ? 'within expected status' : `expected ${expectedText}, got ${status}`,
  };
}

export function compareApiResult(
  current: ApiResult,
  baseline: ApiResult | null,
  options: ApiCompareOptions,
): Check[] {
  const checks: Check[] = [];

  for (const metric of API_METRIC_SPECS) {
    const rule = options.budgets[metric.key];
    if (!rule || (rule.max === undefined && rule.regression === undefined)) continue;

    checks.push(
      evaluateBudget({
        metric: metric.key,
        label: metric.label,
        value: current.metrics[metric.key],
        baselineValue: baseline?.metrics?.[metric.key],
        rule,
        format: metric.format,
        defaultSeverity: metric.defaultSeverity,
        strict: options.strict === true,
      }),
    );
  }

  checks.push(evaluateApiStatus(current, baseline, options.expectStatus));
  return checks;
}
