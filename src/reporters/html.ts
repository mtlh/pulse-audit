import { join } from 'node:path';
import { checkNotes, checkViews, countChecks, findCheck, type CheckView } from '../checks.js';
import { countViolationNodes, countViolationNodesByImpact } from '../compare.js';
import { escapeHtml, formatBytes, formatPercent, formatValue } from '../format.js';
import type {
  A11yImpact,
  A11yViolation,
  ApiReportEntry,
  Check,
  LongTaskDetail,
  ConsoleError,
  PulseReport,
  ReportEntry,
  RequestSummary,
  ThirdPartyCpu,
} from '../types.js';
import { IMPACT_ORDER } from '../util/a11y.js';
import { writeTextFile } from '../util/files.js';
import { VERSION } from '../version.js';
import { apiSpreadRows, spreadRows } from './spread.js';

function statusPill(check: Check): string {
  return `<span class="pill ${check.status}">${check.status}</span>`;
}

function deltaCell(view: CheckView): string {
  if (!view.hasDelta) {
    // A status check has a baseline but no meaningful numeric delta.
    return `<span class="muted">${view.hasBaseline ? '—' : 'no baseline'}</span>`;
  }
  const delta = view.check.delta ?? 0;
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
  return `<span class="delta ${direction}">${escapeHtml(view.deltaText)}</span> <span class="muted">${escapeHtml(
    view.deltaPctText,
  )}</span>`;
}

function budgetCell(view: CheckView): string {
  if (view.check.max === undefined) return '<span class="muted">—</span>';
  return escapeHtml(view.budget);
}

function metricValue(entry: ReportEntry, metric: 'lcp' | 'cls'): string {
  const check = findCheck(entry, metric);
  if (check) return check.formatted;
  return formatValue(entry.audit.metrics[metric], metric === 'lcp' ? 'ms' : 'score');
}

function renderChecks(checks: Check[]): string {
  const rows = checkViews(checks)
    .map(
      (view) => `<tr>
        <td class="metric">${escapeHtml(view.label)}</td>
        <td class="value">${escapeHtml(view.value)}</td>
        <td>${deltaCell(view)}</td>
        <td class="muted">${budgetCell(view)}</td>
        <td>${statusPill(view.check)}</td>
      </tr>`,
    )
    .join('');

  const notes = checkNotes(checks)
    .map((note) => `<li><strong>${escapeHtml(note.label)}</strong> — ${escapeHtml(note.reason)}</li>`)
    .join('');

  return `<table class="checks">
    <thead><tr><th>Metric</th><th>Result</th><th>vs baseline</th><th>Budget</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>${notes ? `<ul class="notes">${notes}</ul>` : ''}`;
}

function renderLcp(entry: ReportEntry): string {
  const element = entry.audit.lcpElement;
  if (!element) {
    return `<section class="card"><h3>LCP element</h3><p class="muted">Not reported by this Lighthouse version.</p></section>`;
  }
  return `<section class="card">
    <h3>LCP element</h3>
    <code class="selector">${escapeHtml(element.selector)}</code>
    ${element.url ? `<p class="muted break">${escapeHtml(element.url)}</p>` : ''}
    ${element.snippet ? `<pre class="snippet">${escapeHtml(element.snippet)}</pre>` : ''}
    <p class="hint">If this is a CSS background image, the browser discovers it late. Use an <code>&lt;img&gt;</code> with <code>fetchpriority="high"</code> and a preload hint.</p>
  </section>`;
}

function requestList(requests: RequestSummary[], showThirdParty: boolean): string {
  const max = Math.max(...requests.map((request) => request.bytes), 1);

  return requests
    .map((request) => {
      const width = Math.max(2, Math.round((request.bytes / max) * 100));
      let label = request.url;
      try {
        const parsed = new URL(request.url);
        label = `${parsed.hostname}${parsed.pathname}`;
      } catch {
        // keep the raw url
      }
      return `<li class="req">
        <div class="req-top">
          <span class="req-url" title="${escapeHtml(request.url)}">${escapeHtml(label)}</span>
          <span class="req-meta">${escapeHtml(request.resourceType)} · ${formatBytes(request.bytes)}${
            showThirdParty && request.thirdParty ? ' · <span class="third">3rd party</span>' : ''
          }</span>
        </div>
        <div class="bar"><span style="width:${width}%"></span></div>
      </li>`;
    })
    .join('');
}

function renderRequests(entry: ReportEntry): string {
  const requests = entry.audit.heaviest;
  if (requests.length === 0) {
    return `<section class="card"><h3>Heaviest requests</h3><p class="muted">No requests captured.</p></section>`;
  }

  return `<section class="card">
    <h3>Heaviest requests</h3>
    <ul class="reqs">${requestList(requests, true)}</ul>
  </section>`;
}

function failedStatusLabel(request: RequestSummary): string {
  if (request.statusCode !== undefined && request.statusCode >= 400) return String(request.statusCode);
  return 'aborted';
}

function renderFailedRequests(entry: ReportEntry): string {
  const count = entry.audit.metrics.failedRequests;
  if (count <= 0) return '';

  const requests = entry.audit.failedRequestDetails ?? [];
  const summary = `${count} request${count === 1 ? '' : 's'}`;

  if (requests.length === 0) {
    return `<section class="card"><h3>Failed requests <span class="muted">${summary}</span></h3><p class="muted">Per-request detail was not captured.</p></section>`;
  }

  const items = requests
    .map((request) => {
      let label = request.url;
      try {
        const parsed = new URL(request.url);
        label = `${parsed.hostname}${parsed.pathname}`;
      } catch {
        // keep the raw url
      }
      return `<li class="req">
        <div class="req-top">
          <span class="req-url" title="${escapeHtml(request.url)}">${escapeHtml(label)}</span>
          <span class="req-meta"><span class="req-fail">${escapeHtml(
            failedStatusLabel(request),
          )}</span> · ${escapeHtml(request.resourceType)}</span>
        </div>
      </li>`;
    })
    .join('');

  return `<section class="card">
    <h3>Failed requests <span class="muted">${summary}</span></h3>
    <ul class="reqs">${items}</ul>
  </section>`;
}

function renderThirdParty(entry: ReportEntry): string {
  const requests = entry.audit.thirdPartyHeaviest ?? [];
  const cpu = entry.audit.thirdPartyCpu ?? [];
  const bytes = entry.audit.metrics.thirdPartyBytes;
  const count = entry.audit.metrics.thirdPartyRequests;
  const sections: string[] = [];

  if (requests.length > 0) {
    sections.push(`<ul class="reqs">${requestList(requests, false)}</ul>`);
  } else if (bytes > 0) {
    sections.push(
      `<p class="muted">${formatBytes(
        bytes,
      )} from third-party origins; per-request detail was not captured.</p>`,
    );
  }

  if (cpu.length > 0) {
    sections.push(
      `<h4 class="subhead">Main-thread CPU time <span class="muted">${escapeHtml(
        formatValue(entry.audit.metrics.thirdPartyMainThread, 'ms'),
      )}</span></h4>`,
      `<ul class="reqs">${cpuList(cpu)}</ul>`,
    );
  }

  if (sections.length === 0) return '';

  const heading =
    requests.length > 0
      ? `<h3>Third-party requests <span class="muted">${count} request${
          count === 1 ? '' : 's'
        } · ${formatBytes(bytes)}</span></h3>`
      : '<h3>Third-party requests</h3>';

  return `<section class="card">${heading}${sections.join('')}</section>`;
}

function cpuList(cpu: ThirdPartyCpu[]): string {
  const max = Math.max(...cpu.map((item) => item.mainThreadTime), 1);

  return cpu
    .map((item) => {
      const width = Math.max(2, Math.round((item.mainThreadTime / max) * 100));
      return `<li class="req">
        <div class="req-top">
          <span class="req-url" title="${escapeHtml(item.entity)}">${escapeHtml(item.entity)}</span>
          <span class="req-meta">${escapeHtml(formatValue(item.mainThreadTime, 'ms'))} · ${formatBytes(
            item.transferSize,
          )}</span>
        </div>
        <div class="bar"><span style="width:${width}%"></span></div>
      </li>`;
    })
    .join('');
}

function consoleLocation(error: ConsoleError): string | undefined {
  const parts: string[] = [];
  if (error.url) parts.push(error.url);
  if (error.line !== undefined) parts.push(`line ${error.line}`);
  if (error.column !== undefined) parts.push(`column ${error.column}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Lists the unique console errors Lighthouse captured. Omitted entirely when
 * the count is zero, so a clean page does not get an empty card.
 */
function renderConsoleErrors(entry: ReportEntry): string {
  const count = entry.audit.metrics.consoleErrors;
  if (count <= 0) return '';

  const heading = `<h3>Console errors <span class="muted">${count} unique</span></h3>`;
  const errors = entry.audit.consoleErrorDetails ?? [];

  if (errors.length === 0) {
    return `<section class="card">${heading}<p class="muted">${count} console error${
      count === 1 ? '' : 's'
    } captured; per-error detail was not recorded.</p></section>`;
  }

  const rows = errors
    .map((error) => {
      const location = consoleLocation(error);
      return `<li class="console-error">
        <div class="console-message">${escapeHtml(error.description)}</div>
        ${location ? `<div class="console-source break">${escapeHtml(location)}</div>` : ''}
      </li>`;
    })
    .join('');

  const remaining = count - errors.length;
  return `<section class="card">
    ${heading}
    <ul class="console-errors">${rows}</ul>
    ${remaining > 0 ? `<p class="hint">${remaining} more not shown.</p>` : ''}
  </section>`;
}

/**
 * Counts violation nodes with the same identity and de-duplication rules as the
 * gate, so the summary card cannot claim a different total from the check table.
 */
function impactCounts(violations: A11yViolation[]): Record<A11yImpact, number> {
  const counts = {} as Record<A11yImpact, number>;
  for (const impact of IMPACT_ORDER) {
    counts[impact] = countViolationNodesByImpact({ violations }, impact);
  }
  return counts;
}

function ignoredNote(entry: ReportEntry): string {
  if (!entry.ignoredRules || entry.ignoredRules.length === 0) return '';
  const nodes = entry.ignoredViolations ?? 0;
  return `<p class="hint">Ignored ${nodes} node${nodes === 1 ? '' : 's'} via <code>ignoreRules</code>: ${entry.ignoredRules
    .map((rule) => `<code>${escapeHtml(rule)}</code>`)
    .join(', ')}. Suppressed findings are not gated.</p>`;
}

function renderA11y(entry: ReportEntry): string {
  const violations = entry.audit.violations;
  const ignored = ignoredNote(entry);
  if (violations.length === 0) {
    return `<section class="card"><h3>Accessibility</h3><p class="ok">No axe violations found.</p>${ignored}</section>`;
  }

  const counts = impactCounts(violations);
  const nodes = countViolationNodes({ violations });
  const impacts = IMPACT_ORDER.filter((impact) => counts[impact] > 0)
    .map((impact) => `${counts[impact]} ${impact}`)
    .join(' · ');

  const rows = violations
    .map(
      (violation) => `<details class="violation">
        <summary>
          <span class="impact ${escapeHtml(violation.impact)}">${escapeHtml(violation.impact)}</span>
          ${escapeHtml(violation.title)}
          <code class="rule">${escapeHtml(violation.id)}</code>
        </summary>
        <ul>${violation.nodes
          .map(
            (node) =>
              `<li><code>${escapeHtml(node.selector)}</code>${
                node.snippet ? `<pre class="snippet">${escapeHtml(node.snippet)}</pre>` : ''
              }</li>`,
          )
          .join('')}</ul>
      </details>`,
    )
    .join('');

  return `<section class="card">
    <h3>Accessibility <span class="muted">${nodes} node${nodes === 1 ? '' : 's'}${
      impacts ? ` · ${impacts}` : ''
    }</span></h3>
    ${ignored}
    ${rows}
  </section>`;
}

function measuredRuns(entry: ReportEntry): number {
  return entry.audit.samples?.length ?? entry.audit.runs;
}

function renderVariance(entry: ReportEntry): string {
  const rows = spreadRows(entry);
  if (rows.length === 0) return '';

  const body = rows
    .map(
      ({ check, stat }) => `<tr>
        <td class="metric">${escapeHtml(check.label)}</td>
        <td class="value">${escapeHtml(formatValue(stat.min, check.format))}</td>
        <td class="value">${escapeHtml(formatValue(stat.median, check.format))}</td>
        <td class="value">${escapeHtml(formatValue(stat.max, check.format))}</td>
        <td class="muted">${escapeHtml(formatPercent(stat.spreadPct))}</td>
      </tr>`,
    )
    .join('');

  return `<section class="card">
    <h3>Run variance <span class="muted">${measuredRuns(entry)} runs</span></h3>
    <table class="checks compact">
      <thead><tr><th>Metric</th><th>Min</th><th>Median</th><th>Max</th><th>Spread</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

/**
 * Renders the longest main-thread tasks. Each row is scaled against the longest
 * task, matching the request cards, so the relative cost is visible at a glance.
 */
function renderLongTasks(entry: ReportEntry): string {
  const count = entry.audit.metrics.longTasks;
  const tasks: LongTaskDetail[] = entry.audit.longTaskDetails ?? [];

  if (tasks.length === 0) {
    if (count <= 0) return '';
    return `<section class="card"><h3>Long tasks</h3><p class="muted">${count} task${
      count === 1 ? '' : 's'
    } of 50ms or more; per-task detail was not captured.</p></section>`;
  }

  const max = Math.max(...tasks.map((task) => task.duration), 1);
  const rows = tasks
    .map((task) => {
      const width = Math.max(2, Math.round((task.duration / max) * 100));
      let label = 'Unattributed';
      if (task.url) {
        label = task.url;
        try {
          const parsed = new URL(task.url);
          label = `${parsed.hostname}${parsed.pathname}`;
        } catch {
          // keep the raw url
        }
      }
      return `<li class="req">
        <div class="req-top">
          <span class="req-url"${task.url ? ` title="${escapeHtml(task.url)}"` : ''}>${escapeHtml(
            label,
          )}</span>
          <span class="req-meta">${escapeHtml(formatValue(task.duration, 'ms'))}</span>
        </div>
        <div class="bar"><span style="width:${width}%"></span></div>
      </li>`;
    })
    .join('');

  return `<section class="card">
    <h3>Long tasks <span class="muted">${count} task${count === 1 ? '' : 's'} &ge; 50ms</span></h3>
    <ul class="reqs">${rows}</ul>
  </section>`;
}

function renderExtras(entry: ReportEntry): string {
  const cards = [
    renderFailedRequests(entry),
    renderVariance(entry),
    renderLongTasks(entry),
    renderThirdParty(entry),
    renderConsoleErrors(entry),
  ].filter(Boolean);
  if (cards.length === 0) return '';
  return `<div class="extras">${cards.join('')}</div>`;
}

function renderEntry(entry: ReportEntry, index: number): string {
  const meta = [
    entry.audit.preset,
    `${measuredRuns(entry)} run${measuredRuns(entry) === 1 ? '' : 's'}`,
    entry.method === 'fast' ? 'fast pre-check' : 'Lighthouse',
    entry.baseline ? 'compared to baseline' : 'no baseline',
  ].join(' · ');

  const fastNote =
    entry.method === 'fast'
      ? `<p class="notes"><strong>Fast pre-check.</strong> Enforced: ${escapeHtml(
          entry.enforcedBudgets?.join(', ') ?? 'no budgets',
        )}. Performance timings were not measured, so performance budgets are not fully enforced.</p>`
      : '';

  return `<section class="report" id="url-${index + 1}">
    <div class="report-head">
      <h2>${escapeHtml(entry.url)}</h2>
      <p class="muted">${escapeHtml(meta)}</p>
    </div>
    ${fastNote}
    ${renderChecks(entry.checks)}
    <div class="grid">
      ${renderLcp(entry)}
      ${renderRequests(entry)}
    </div>
    ${renderExtras(entry)}
    ${renderA11y(entry)}
  </section>`;
}

function renderApiVariance(entry: ApiReportEntry): string {
  const rows = apiSpreadRows(entry);
  if (rows.length === 0) return '';

  const body = rows
    .map(
      ({ check, stat }) => `<tr>
        <td class="metric">${escapeHtml(check.label)}</td>
        <td class="value">${escapeHtml(formatValue(stat.min, check.format))}</td>
        <td class="value">${escapeHtml(formatValue(stat.median, check.format))}</td>
        <td class="value">${escapeHtml(formatValue(stat.max, check.format))}</td>
        <td class="muted">${escapeHtml(formatPercent(stat.spreadPct))}</td>
      </tr>`,
    )
    .join('');

  return `<section class="card">
    <h3>Run variance <span class="muted">${entry.result.samples?.length ?? entry.result.runs} runs</span></h3>
    <table class="checks compact">
      <thead><tr><th>Metric</th><th>Min</th><th>Median</th><th>Max</th><th>Spread</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

function renderApiEntry(entry: ApiReportEntry, index: number): string {
  const metrics = entry.result.metrics;
  const meta = [
    String(metrics.status),
    formatBytes(metrics.bytes),
    `${entry.result.runs} run${entry.result.runs === 1 ? '' : 's'}`,
    entry.baseline ? 'compared to baseline' : 'no baseline',
  ].join(' · ');

  return `<section class="report api-report" id="api-${index + 1}">
    <div class="report-head">
      <h2><span class="method">${escapeHtml(entry.method)}</span> ${escapeHtml(entry.url)}</h2>
      <p class="muted">${escapeHtml(meta)}</p>
    </div>
    ${renderChecks(entry.checks)}
    ${renderApiVariance(entry)}
  </section>`;
}

function entryCounts(entry: { checks: Check[] }): { failed: number; warned: number; passed: number } {
  return countChecks(entry.checks);
}

function renderCrossSummary(report: PulseReport): string {
  if (report.results.length <= 1) return '';

  const rows = report.results
    .map((entry, index) => {
      const counts = entryCounts(entry);
      return `<tr>
        <td class="metric"><a href="#url-${index + 1}">${escapeHtml(entry.url)}</a></td>
        <td>${escapeHtml(entry.audit.preset)}</td>
        <td class="num">${counts.failed}</td>
        <td class="num">${counts.warned}</td>
        <td class="num">${counts.passed}</td>
        <td class="value">${escapeHtml(metricValue(entry, 'lcp'))}</td>
        <td class="value">${escapeHtml(metricValue(entry, 'cls'))}</td>
      </tr>`;
    })
    .join('');

  return `<section class="card cross-card">
    <h3>Cross-URL summary</h3>
    <table class="checks cross">
      <thead><tr><th>URL</th><th>Preset</th><th>Failed</th><th>Warned</th><th>Passed</th><th>LCP</th><th>CLS</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderApiCrossSummary(apiResults: ApiReportEntry[]): string {
  if (apiResults.length <= 1) return '';

  const rows = apiResults
    .map((entry, index) => {
      const counts = entryCounts(entry);
      const ttfb = findCheck(entry, 'ttfb')?.formatted ?? formatValue(entry.result.metrics.ttfb, 'ms');
      const duration =
        findCheck(entry, 'duration')?.formatted ?? formatValue(entry.result.metrics.duration, 'ms');
      return `<tr>
        <td class="metric"><a href="#api-${index + 1}"><span class="method">${escapeHtml(
          entry.method,
        )}</span> ${escapeHtml(entry.url)}</a></td>
        <td class="num">${entry.result.metrics.status}</td>
        <td class="num">${counts.failed}</td>
        <td class="num">${counts.warned}</td>
        <td class="num">${counts.passed}</td>
        <td class="value">${escapeHtml(ttfb)}</td>
        <td class="value">${escapeHtml(duration)}</td>
      </tr>`;
    })
    .join('');

  return `<section class="card cross-card">
    <h3>API summary</h3>
    <table class="checks cross">
      <thead><tr><th>Endpoint</th><th>Status</th><th>Failed</th><th>Warned</th><th>Passed</th><th>TTFB</th><th>Duration</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

export function renderHtml(report: PulseReport): string {
  const apiResults = report.apiResults ?? [];
  const summary = [
    `<span class="chip fail"><strong>${report.failed}</strong> failed</span>`,
    `<span class="chip warn"><strong>${report.warned}</strong> warned</span>`,
    `<span class="chip pass"><strong>${report.passed}</strong> passed</span>`,
  ].join('');
  const hasBothKinds = report.results.length > 0 && apiResults.length > 0;
  const title = [
    ...report.results.map((entry) => entry.url),
    ...apiResults.map((entry) => `${entry.method} ${entry.url}`),
  ].join(', ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pulse audit — ${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --panel: #ffffff; --text: #101828; --muted: #667085;
    --border: #e4e7ec; --pass: #067647; --fail: #b42318; --warn: #b54708;
    --accent: #175cd3; --bar: #dbe7ff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0d10; --panel: #14171c; --text: #e7e9ee; --muted: #98a2b3;
      --border: #242a33; --pass: #4ade80; --fail: #f87171; --warn: #fbbf24;
      --accent: #84adff; --bar: #1d2a44;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 15px; line-height: 1.5;
  }
  .page { max-width: 940px; margin: 0 auto; padding: 40px 20px 64px; }
  header { margin-bottom: 28px; }
  .brand { font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--pass); margin-right: 7px; }
  h1 { font-size: 30px; line-height: 1.15; margin: 10px 0 6px; letter-spacing: -.02em; }
  h2 { font-size: 18px; margin: 0; letter-spacing: -.01em; }
  h3 { font-size: 14px; margin: 0 0 10px; letter-spacing: .01em; }
  .kind-head { margin: 34px 0 0; padding-bottom: 8px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .method { display: inline-block; padding: 1px 7px; border: 1px solid var(--border); border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 700; letter-spacing: .04em; vertical-align: middle; }
  .muted { color: var(--muted); font-weight: 400; }
  .subhead { margin: 16px 0 10px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .chip { display: inline-block; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel); margin-right: 8px; font-size: 13px; }
  .chip.fail { color: var(--fail); } .chip.warn { color: var(--warn); } .chip.pass { color: var(--pass); }
  .report { margin-top: 30px; }
  .report-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
  .report-head p { margin: 0; font-size: 13px; }
  .checks { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .checks th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 10px 14px; border-bottom: 1px solid var(--border); font-weight: 600; }
  .checks td { padding: 11px 14px; border-bottom: 1px solid var(--border); font-size: 14px; }
  .checks tr:last-child td { border-bottom: none; }
  .checks .metric { font-weight: 600; }
  .checks .value { font-variant-numeric: tabular-nums; }
  .checks a { color: var(--accent); text-decoration: none; }
  .checks a:hover { text-decoration: underline; }
  .checks.compact th { padding: 6px 8px; font-size: 10px; }
  .checks.compact td { padding: 6px 8px; font-size: 12.5px; }
  .cross-card { margin-top: 0; }
  .cross .num { text-align: right; font-variant-numeric: tabular-nums; }
  .notes { margin: 8px 0 0; padding-left: 18px; font-size: 12.5px; color: var(--muted); }
  .notes li { margin-bottom: 3px; }
  .delta.up { color: var(--fail); } .delta.down { color: var(--pass); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .pill.pass { color: var(--pass); background: color-mix(in srgb, var(--pass) 12%, transparent); }
  .pill.fail { color: var(--fail); background: color-mix(in srgb, var(--fail) 12%, transparent); }
  .pill.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin-top: 14px; }
  .extras { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; margin-top: 14px; }
  .card { min-width: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-top: 14px; }
  .grid .card { margin-top: 0; }
  .extras .card { margin-top: 0; }
  .report-head h2 { overflow-wrap: anywhere; }
  .selector, .rule { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 2px 6px; overflow-wrap: anywhere; }
  .snippet { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; }
  .break { word-break: break-all; }
  .hint { font-size: 12.5px; color: var(--muted); margin: 12px 0 0; }
  .reqs { list-style: none; margin: 0; padding: 0; min-width: 0; }
  .req { margin-bottom: 12px; min-width: 0; }
  .req:last-child { margin-bottom: 0; }
  .req-top { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; margin-bottom: 4px; min-width: 0; }
  .req-url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .req-meta { color: var(--muted); white-space: nowrap; }
  .console-errors { list-style: none; margin: 0; padding: 0; min-width: 0; }
  .console-error { border-top: 1px solid var(--border); padding: 8px 0; min-width: 0; }
  .console-error:first-child { border-top: none; padding-top: 0; }
  .console-message { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; overflow-wrap: anywhere; }
  .console-source { color: var(--muted); font-size: 11.5px; margin-top: 3px; }
  .third { color: var(--warn); }
  .req-fail { color: var(--fail); font-weight: 700; }
  .bar { height: 5px; background: var(--bar); border-radius: 999px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
  .ok { color: var(--pass); margin: 0; }
  .violation { border-top: 1px solid var(--border); padding: 10px 0; }
  .violation:first-of-type { border-top: none; padding-top: 0; }
  .violation summary { cursor: pointer; font-size: 13.5px; }
  .violation ul { margin: 8px 0 0; padding-left: 20px; }
  .violation li { margin-bottom: 6px; }
  .impact { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; margin-right: 6px; color: var(--warn); }
  .impact.critical, .impact.serious { color: var(--fail); }
  .rule { margin-left: 6px; }
  footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
  @media (max-width: 700px) {
    .grid { grid-template-columns: 1fr; }
    .report > .checks th:nth-child(3), .report > .checks td:nth-child(3) { display: none; }
    .checks th, .checks td { padding: 10px 8px; }
    .checks .value, .report > .checks td:nth-child(4) { white-space: nowrap; }
    h1 { font-size: 24px; }
  }
</style>
</head>
<body>
<div class="page">
  <header>
    <div class="brand"><span class="dot"></span>pulse audit</div>
    <h1>Performance, accessibility &amp; weight report</h1>
    <p class="muted">${escapeHtml(report.presets.join(', ') || 'API')} · ${report.runs} run${
      report.runs === 1 ? '' : 's'
    } · ${escapeHtml(new Date(report.generatedAt).toLocaleString('en-GB'))}</p>
    <div style="margin-top:14px">${summary}</div>
  </header>
  ${renderCrossSummary(report)}
  ${hasBothKinds ? '<div class="kind-head">UI pages</div>' : ''}
  ${report.results.map((entry, index) => renderEntry(entry, index)).join('')}
  ${renderApiCrossSummary(apiResults)}
  ${apiResults.length > 0 ? '<div class="kind-head">API timings</div>' : ''}
  ${apiResults.map((entry, index) => renderApiEntry(entry, index)).join('')}
  <footer>Generated by pulse-audit v${escapeHtml(VERSION)} · report schema v${escapeHtml(report.version)} · UI budgets are compared to a baseline captured on the same preset and run count; API budgets are compared to the same method and run count.</footer>
</div>
</body>
</html>`;
}

export async function writeHtmlReport(report: PulseReport, outDir: string): Promise<string> {
  const path = join(outDir, 'report.html');
  await writeTextFile(path, renderHtml(report));
  return path;
}
