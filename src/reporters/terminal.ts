import pc from 'picocolors';
import { formatDelta, formatPercent, formatValue, noteworthyReason } from '../format.js';
import type { Check, PulseReport } from '../types.js';

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

export function printReport(report: PulseReport): void {
  console.log('');
  console.log(
    `${pc.bold('pulse')} ${pc.dim(
      `${report.preset} · ${report.runs} run${report.runs === 1 ? '' : 's'} · ${report.generatedAt}`,
    )}`,
  );

  for (const entry of report.results) {
    console.log('');
    console.log(pc.bold(entry.url));
    console.log(pc.dim('─'.repeat(Math.min(78, entry.url.length + 24))));
    console.log(
      pc.dim(
        `${pad('  metric', 24)}${pad('result', 12)}${pad('delta', 16)}${pad('budget', 12)}status`,
      ),
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
