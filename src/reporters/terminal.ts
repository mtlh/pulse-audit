import pc from 'picocolors';
import { checkViews } from '../checks.js';
import { formatValue } from '../format.js';
import type { ApiReportEntry, Check, PulseReport, ReportEntry } from '../types.js';
import { padRight, truncate } from '../util/text.js';
import { apiSpreadParts, spreadParts } from './spread.js';

const SPREAD_PREFIX = '  spread   ';
const SPREAD_WIDTH = 100;

function statusLabel(check: Check): string {
  if (check.status === 'fail') return pc.red('FAIL');
  if (check.status === 'warn') return pc.yellow('WARN');
  return pc.green('pass');
}

function spreadLine(parts: string[]): string | undefined {
  if (parts.length === 0) return undefined;
  return truncate(`${SPREAD_PREFIX}${parts.join(' · ')}`, SPREAD_WIDTH);
}

function printChecks(checks: Check[]): void {
  const views = checkViews(checks);
  console.log(
    pc.dim(
      `${padRight('  metric', 24)}${padRight('result', 12)}${padRight('delta', 16)}${padRight('budget', 12)}status`,
    ),
  );

  for (const view of views) {
    console.log(
      padRight(`  ${view.label}`, 24) +
        padRight(view.value, 12) +
        padRight(view.deltaSummary, 16) +
        padRight(view.budget, 12) +
        statusLabel(view.check),
    );
    if (view.note) console.log(pc.dim(`      ↳ ${view.note}`));
  }
}

function printEntry(entry: ReportEntry): void {
  console.log('');
  console.log(pc.bold(entry.url));
  console.log(pc.dim('─'.repeat(Math.min(78, entry.url.length + 24))));
  if (entry.method === 'fast') {
    console.log(
      pc.yellow(
        `      ↳ fast pre-check: enforced ${
          entry.enforcedBudgets?.join(', ') ?? 'no budgets'
        }; performance timings were not measured`,
      ),
    );
  }
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
