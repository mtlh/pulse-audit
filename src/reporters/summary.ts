import { checkNotes, checkViews } from '../checks.js';
import { formatValue } from '../format.js';
import type { Check, PulseReport, ReportEntry, RequestSummary } from '../types.js';
import { readTextIfPresent, writeTextFile } from '../util/files.js';
import { apiSpreadParts, spreadParts } from './spread.js';

const SUMMARY_START = '<!-- pulse:start -->';
const SUMMARY_END = '<!-- pulse:end -->';
/** Keep the PR summary short: five descriptions are enough to recognise debt. */
const MAX_SUMMARY_CONSOLE_ERRORS = 5;

function spreadLine(parts: string[]): string | undefined {
  return parts.length > 0 ? `**Run spread**: ${parts.join(' · ')}` : undefined;
}

function failedRequestBullet(request: RequestSummary): string {
  const status =
    request.statusCode !== undefined && request.statusCode >= 400 ? String(request.statusCode) : 'aborted';
  return `- **Failed request**: ${status} \`${request.url}\` (${request.resourceType})`;
}

/**
 * One compact bullet with the current unique console errors. Returns undefined
 * when the page logged none, so clean runs keep the summary unchanged.
 */
function consoleErrorLine(entry: ReportEntry): string | undefined {
  const count = entry.audit.metrics.consoleErrors;
  if (count <= 0) return undefined;

  const shown = (entry.audit.consoleErrorDetails ?? [])
    .slice(0, MAX_SUMMARY_CONSOLE_ERRORS)
    .map((error) => error.description);
  const remaining = count - shown.length;
  const suffix = remaining > 0 ? ` (+${remaining} more)` : '';
  return `- **Console errors** (${count})${shown.length > 0 ? `: ${shown.join('; ')}${suffix}` : ''}`;
}

function checkTable(checks: Check[]): string[] {
  const lines = ['| Check | Result | Budget | vs baseline | Status |', '| --- | ---: | ---: | ---: | --- |'];
  for (const view of checkViews(checks)) {
    lines.push(
      `| ${view.label} | ${view.value} | ${view.budget} | ${view.deltaSummary} | ${view.statusLabel} |`,
    );
  }
  return lines;
}

/** Bulleted notes for checks whose status alone would hide a problem. */
function noteLines(checks: Check[]): string[] {
  return checkNotes(checks).flatMap((note) => ['', `- **${note.label}**: ${note.reason}`]);
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
    if (entry.method === 'fast') {
      lines.push(
        `> ⚠️ **Fast pre-check.** Enforced: ${
          entry.enforcedBudgets?.join(', ') ?? 'no budgets'
        }. Performance timings were not measured; performance budgets are not fully enforced.`,
        '',
      );
    }
    lines.push(...checkTable(entry.checks));

    const spread = spreadLine(spreadParts(entry));
    if (spread) lines.push('', spread);

    lines.push(...noteLines(entry.checks));

    for (const request of (entry.audit.failedRequestDetails ?? []).slice(0, 5)) {
      lines.push('', failedRequestBullet(request));
    }
    const consoleErrors = consoleErrorLine(entry);
    if (consoleErrors) lines.push('', consoleErrors);

    const thirdPartyMainThread = entry.audit.metrics.thirdPartyMainThread;
    if (thirdPartyMainThread > 0) {
      lines.push('', `- **Third-party main thread**: ${formatValue(thirdPartyMainThread, 'ms')}`);
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

      lines.push(...noteLines(entry.checks));
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Replaces the pulse block in an existing Markdown file instead of appending a
 * new section on every run. Content outside the markers is preserved byte for
 * byte (apart from the single newline that separates it from the block).
 */
export async function upsertSummary(path: string, markdown: string): Promise<void> {
  const existing = (await readTextIfPresent(path)) ?? '';
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

  await writeTextFile(path, `${before}${block}${after}`);
}
