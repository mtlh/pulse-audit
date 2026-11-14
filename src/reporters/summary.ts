import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { formatDelta, formatPercent, formatValue, noteworthyReason } from '../format.js';
import type { Check, PulseReport, RequestSummary } from '../types.js';
import { apiSpreadParts, spreadParts } from './spread.js';

const SUMMARY_START = '<!-- pulse:start -->';
const SUMMARY_END = '<!-- pulse:end -->';

function spreadLine(parts: string[]): string | undefined {
  return parts.length > 0 ? `**Run spread**: ${parts.join(' · ')}` : undefined;
}

function failedRequestBullet(request: RequestSummary): string {
  const status =
    request.statusCode !== undefined && request.statusCode >= 400 ? String(request.statusCode) : 'aborted';
  return `- **Failed request**: ${status} \`${request.url}\` (${request.resourceType})`;
}

function checkTable(checks: Check[]): string[] {
  const lines = ['| Check | Result | Budget | vs baseline | Status |', '| --- | ---: | ---: | ---: | --- |'];

  for (const check of checks) {
    const budget = check.max === undefined ? '—' : formatValue(check.max, check.format);
    const delta =
      check.delta === undefined
        ? '—'
        : `${formatDelta(check.delta, check.format)} (${formatPercent(check.deltaPct)})`;
    const status = check.status === 'pass' ? 'pass' : check.status.toUpperCase();
    lines.push(`| ${check.label} | ${check.formatted} | ${budget} | ${delta} | ${status} |`);
  }

  return lines;
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
    lines.push(...checkTable(entry.checks));

    const spread = spreadLine(spreadParts(entry));
    if (spread) lines.push('', spread);

    const notes = entry.checks
      .map((check) => ({ label: check.label, reason: noteworthyReason(check) }))
      .filter((note): note is { label: string; reason: string } => note.reason !== undefined);
    for (const note of notes) lines.push('', `- **${note.label}**: ${note.reason}`);

    for (const request of (entry.audit.failedRequestDetails ?? []).slice(0, 5)) {
      lines.push('', failedRequestBullet(request));
    }

    if (entry.ignoredRules && entry.ignoredRules.length > 0) {
      lines.push(
        '',
        `- **Ignored a11y**: ${entry.ignoredViolations ?? 0} node${
          entry.ignoredViolations === 1 ? '' : 's'
        } via \`${entry.ignoredRules.join('`, `')}\``,
      );
    }

    const longTasks = entry.audit.metrics.longTasks;
    if (longTasks > 0) {
      const longest = entry.audit.longTaskDetails?.[0];
      const detail = longest
        ? ` · longest ${formatValue(longest.duration, 'ms')}${longest.url ? ` (${longest.url})` : ''}`
        : '';
      lines.push('', `- **Long tasks**: ${longTasks} ≥ 50ms${detail}`);
    }

    lines.push('');
  }

  const apiResults = report.apiResults ?? [];
  if (apiResults.length > 0) {
    lines.push('## API timings', '');
    for (const entry of apiResults) {
      lines.push(`### ${entry.method} ${entry.url}`, '');
      lines.push(
        `**Response**: ${entry.result.metrics.status} · ${formatValue(
          entry.result.metrics.bytes,
          'bytes',
        )} · ${entry.result.runs} run${entry.result.runs === 1 ? '' : 's'}`,
        '',
      );
      lines.push(...checkTable(entry.checks));

      const spread = spreadLine(apiSpreadParts(entry));
      if (spread) lines.push('', spread);

      const notes = entry.checks
        .map((check) => ({ label: check.label, reason: noteworthyReason(check) }))
        .filter((note): note is { label: string; reason: string } => note.reason !== undefined);
      for (const note of notes) lines.push('', `- **${note.label}**: ${note.reason}`);

      lines.push('');
    }
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

  // Never truncate a hand-edited file just because one marker is missing: the
  // user may have content after the start marker that must survive.
  if (start !== -1 && end === -1) {
    throw new Error(
      `Found ${SUMMARY_START} without a matching ${SUMMARY_END} in ${path}. Fix the markers and re-run.`,
    );
  }
  if (start === -1 && existing.includes(SUMMARY_END)) {
    throw new Error(
      `Found ${SUMMARY_END} without a matching ${SUMMARY_START} in ${path}. Fix the markers and re-run.`,
    );
  }

  let before = start === -1 ? existing : existing.slice(0, start);
  let after = end === -1 ? '' : existing.slice(end + SUMMARY_END.length);

  if (start !== -1) {
    // The old block owned its trailing newline; drop one so we do not accumulate
    // blank lines between the new block and the surrounding content.
    after = after.replace(/^\r?\n/, '');
  }

  if (before.length > 0 && !before.endsWith('\n')) before += '\n';

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${before}${block}${after}`, 'utf8');
}
