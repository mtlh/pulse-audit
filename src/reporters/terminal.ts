import pc from 'picocolors';
import { formatDelta, formatPercent, formatValue, noteworthyReason, type ValueFormat } from '../format.js';
import type { AuditMetrics, Check, PulseReport, ReportEntry } from '../types.js';
import { metricSpreads } from '../util/variance.js';

const SPREAD_PREFIX = '  spread   ';
const SPREAD_WIDTH = 100;

/** `1.48–1.61s` rather than `1.48s–1.61s` when both ends share a unit. */
function formatRange(min: number, max: number, format: ValueFormat): string {
  const minText = formatValue(min, format);
  const maxText = formatValue(max, format);
  if (format === 'ms' || format === 'bytes') {
    const minParts = /^([\d.]+)( ?[A-Za-z]+)$/.exec(minText);
    const maxParts = /^([\d.]+)( ?[A-Za-z]+)$/.exec(maxText);
    if (minParts && maxParts && minParts[2] === maxParts[2]) {
      return `${minParts[1]}–${maxText}`;
    }
  }
  return `${minText}–${maxText}`;
}

function statusLabel(check: Check): string {
  if (check.status === 'fail') return pc.red('FAIL');
  if (check.status === 'warn') return pc.yellow('WARN');
  return pc.green('pass');
}

function pad(value: string, width: number): string {
  // Strip ANSI escapes when measuring width.
  const visible = value.replace(/\u001b\[[0-9;]*m/g, '');
  return value + ' '.repeat(Math.max(0, width - visible.length));
}

/** Min–max for every metric that has a check and varied between runs. */
export function spreadParts(entry: ReportEntry): string[] {
  const samples = entry.audit.samples;
  if (!samples || samples.length < 2) return [];

  const spreads = metricSpreads(samples);
  const parts: string[] = [];
  for (const check of entry.checks) {
    const stat = spreads[check.metric as keyof AuditMetrics];
    if (!stat || stat.max === stat.min) continue;
    parts.push(`${check.label} ${formatRange(stat.min, stat.max, check.format)}`);
  }
  return parts;
}

function spreadLine(entry: ReportEntry): string | undefined {
  const parts = spreadParts(entry);
  if (parts.length === 0) return undefined;

  const line = `${SPREAD_PREFIX}${parts.join(' · ')}`;
  if (line.length <= SPREAD_WIDTH) return line;
  return `${line.slice(0, SPREAD_WIDTH - 1).trimEnd()}…`;
}

export function printReport(report: PulseReport): void {
  console.log('');
  console.log(
    `${pc.bold('pulse')} ${pc.dim(
      `${report.presets.join(' + ') || report.preset} · ${report.runs} run${
        report.runs === 1 ? '' : 's'
      } · ${report.generatedAt}`,
    )}`,
  );

  for (const entry of report.results) {
    console.log('');
    console.log(pc.bold(entry.url));
    console.log(pc.dim('─'.repeat(Math.min(78, entry.url.length + 24))));
    console.log(
      pc.dim(`${pad('  metric', 24)}${pad('result', 12)}${pad('delta', 16)}${pad('budget', 12)}status`),
    );

    for (const check of entry.checks) {
      const delta =
        check.delta === undefined
          ? '—'
          : `${formatDelta(check.delta, check.format)} (${formatPercent(check.deltaPct)})`;
      const budget = check.max === undefined ? '—' : formatValue(check.max, check.format);
      console.log(
        pad(`  ${check.label}`, 24) +
          pad(check.formatted, 12) +
          pad(delta, 16) +
          pad(budget, 12) +
          statusLabel(check),
      );
      const note = noteworthyReason(check);
      if (note) console.log(pc.dim(`      ↳ ${note}`));
    }

    if (entry.ignoredRules && entry.ignoredRules.length > 0) {
      console.log(
        pc.dim(
          `      ↳ ignored ${entry.ignoredViolations ?? 0} a11y node${
            entry.ignoredViolations === 1 ? '' : 's'
          } via ${entry.ignoredRules.join(', ')}`,
        ),
      );
    }

    const spread = spreadLine(entry);
    if (spread) console.log(pc.dim(spread));
  }

  console.log('');
  const summary = [
    report.passed > 0 ? pc.green(`${report.passed} passed`) : null,
    report.warned > 0 ? pc.yellow(`${report.warned} warned`) : null,
    report.failed > 0 ? pc.red(`${report.failed} failed`) : null,
  ]
    .filter(Boolean)
    .join(pc.dim(' · '));
  console.log(summary || pc.green('all checks passed'));
}
