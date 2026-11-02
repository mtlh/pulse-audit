import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { formatDelta, formatPercent, formatValue, noteworthyReason, type ValueFormat } from '../format.js';
import type { AuditMetrics, PulseReport, ReportEntry } from '../types.js';
import { metricSpreads } from '../util/variance.js';

const SUMMARY_START = '<!-- pulse:start -->';
const SUMMARY_END = '<!-- pulse:end -->';

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

function spreadLine(entry: ReportEntry): string | undefined {
  const samples = entry.audit.samples;
  if (!samples || samples.length < 2) return undefined;

  const spreads = metricSpreads(samples);
  const parts: string[] = [];
  for (const check of entry.checks) {
    const stat = spreads[check.metric as keyof AuditMetrics];
    if (!stat || stat.max === stat.min) continue;
    parts.push(`${check.label} ${formatRange(stat.min, stat.max, check.format)}`);
  }

  return parts.length > 0 ? `**Run spread**: ${parts.join(' · ')}` : undefined;
}

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

    const spread = spreadLine(entry);
    if (spread) lines.push('', spread);

    const notes = entry.checks
      .map((check) => ({ label: check.label, reason: noteworthyReason(check) }))
      .filter((note): note is { label: string; reason: string } => note.reason !== undefined);
    for (const note of notes) lines.push('', `- **${note.label}**: ${note.reason}`);

    if (entry.ignoredRules && entry.ignoredRules.length > 0) {
      lines.push(
        '',
        `- **Ignored a11y**: ${entry.ignoredViolations ?? 0} node${
          entry.ignoredViolations === 1 ? '' : 's'
        } via \`${entry.ignoredRules.join('`, `')}\``,
      );
    }

    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Replaces the pulse block in an existing Markdown file instead of appending a
 * new section on every run. Content outside the markers is preserved byte for
 * byte (apart from the single newline that separates it from the block).
 */
export async function upsertSummary(path: string, markdown: string): Promise<void> {
  const existing = await readIfPresent(path);
  const block = `${SUMMARY_START}\n${markdown.trimEnd()}\n${SUMMARY_END}\n`;

  const start = existing.indexOf(SUMMARY_START);
  const end = start === -1 ? -1 : existing.indexOf(SUMMARY_END, start + SUMMARY_START.length);

  let before = start === -1 ? existing : existing.slice(0, start);
  let after = end === -1 ? '' : existing.slice(end + SUMMARY_END.length);

  if (start === -1) {
    after = '';
  } else {
    // The old block owned its trailing newline; drop one so we do not accumulate
    // blank lines between the new block and the surrounding content.
    after = after.replace(/^\r?\n/, '');
  }

  if (before.length > 0 && !before.endsWith('\n')) before += '\n';

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${before}${block}${after}`, 'utf8');
}
