import { formatDelta, formatPercent, formatValue, noteworthyReason } from '../format.js';
import type { PulseReport } from '../types.js';

export function renderMarkdown(report: PulseReport): string {
  const lines: string[] = [
    '## Pulse audit',
    '',
    `**${report.failed} failed · ${report.warned} warned · ${report.passed} passed**`,
    '',
  ];

  for (const entry of report.results) {
    lines.push(`### ${entry.url}`, '');
    lines.push('| Check | Result | Budget | vs baseline | Status |');
    lines.push('| --- | ---: | ---: | ---: | --- |');

    for (const check of entry.checks) {
      const budget = check.max === undefined ? '—' : formatValue(check.max, check.format);
      const delta =
        check.delta === undefined
          ? '—'
          : `${formatDelta(check.delta, check.format)} (${formatPercent(check.deltaPct)})`;
      const status = check.status === 'pass' ? 'pass' : check.status.toUpperCase();
      lines.push(`| ${check.label} | ${check.formatted} | ${budget} | ${delta} | ${status} |`);
    }

    const notes = entry.checks
      .map((check) => ({ label: check.label, reason: noteworthyReason(check) }))
      .filter((note): note is { label: string; reason: string } => note.reason !== undefined);
    for (const note of notes) lines.push('', `- **${note.label}**: ${note.reason}`);

    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
