import pc from 'picocolors';
import { formatDelta, formatPercent, formatValue, noteworthyReason } from '../format.js';
import type { ApiReportEntry, Check, PulseReport, ReportEntry } from '../types.js';
import { apiSpreadParts, spreadParts } from './spread.js';

const SPREAD_PREFIX = '  spread   ';
const SPREAD_WIDTH = 100;

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

function spreadLine(parts: string[]): string | undefined {
  if (parts.length === 0) return undefined;

  const line = `${SPREAD_PREFIX}${parts.join(' · ')}`;
  if (line.length <= SPREAD_WIDTH) return line;
  return `${line.slice(0, SPREAD_WIDTH - 1).trimEnd()}…`;
}

function printChecks(checks: Check[]): void {
  console.log(
    pc.dim(`${pad('  metric', 24)}${pad('result', 12)}${pad('delta', 16)}${pad('budget', 12)}status`),
  );

  for (const check of checks) {
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
}

function printEntry(entry: ReportEntry): void {
  console.log('');
  console.log(pc.bold(entry.url));
  console.log(pc.dim('─'.repeat(Math.min(78, entry.url.length + 24))));
  printChecks(entry.checks);

  if (entry.ignoredRules && entry.ignoredRules.length > 0) {
    console.log(
      pc.dim(
        `      ↳ ignored ${entry.ignoredViolations ?? 0} a11y node${
          entry.ignoredViolations === 1 ? '' : 's'
        } via ${entry.ignoredRules.join(', ')}`,
      ),
    );
  }

  const spread = spreadLine(spreadParts(entry));
  if (spread) console.log(pc.dim(spread));
}

function printApiEntry(entry: ApiReportEntry): void {
  const metrics = entry.result.metrics;
  console.log('');
  console.log(pc.bold(`${entry.method} ${entry.url}`));
  console.log(pc.dim('─'.repeat(Math.min(78, entry.url.length + entry.method.length + 25))));
  console.log(
    pc.dim(
      `  ${metrics.status} · ${formatValue(metrics.bytes, 'bytes')} · ${entry.result.runs} run${
        entry.result.runs === 1 ? '' : 's'
      }`,
    ),
  );
  printChecks(entry.checks);

  const spread = spreadLine(apiSpreadParts(entry));
  if (spread) console.log(pc.dim(spread));
}

export function printReport(report: PulseReport): void {
  console.log('');
  console.log(
    `${pc.bold('pulse')} ${pc.dim(
      `${report.presets.join(' + ') || 'API'} · ${report.runs} run${
        report.runs === 1 ? '' : 's'
      } · ${report.generatedAt}`,
    )}`,
  );

  const apiResults = report.apiResults ?? [];
  const hasBothKinds = report.results.length > 0 && apiResults.length > 0;

  if (hasBothKinds) {
    console.log('');
    console.log(pc.bold('UI pages'));
  }

  for (const entry of report.results) printEntry(entry);

  if (hasBothKinds) {
    console.log('');
    console.log(pc.bold('API timings'));
  }

  for (const entry of apiResults) printApiEntry(entry);

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
