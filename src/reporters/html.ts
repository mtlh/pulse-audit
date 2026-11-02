import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeHtml, formatBytes, formatDelta, formatPercent, formatValue, noteworthyReason } from '../format.js';
import type { Check, PulseReport, ReportEntry } from '../types.js';

function statusPill(check: Check): string {
  return `<span class="pill ${check.status}">${check.status}</span>`;
}

function deltaCell(check: Check): string {
  if (check.delta === undefined) return '<span class="muted">no baseline</span>';
  return `<span class="delta ${check.delta > 0 ? 'up' : check.delta < 0 ? 'down' : ''}">${escapeHtml(
    formatDelta(check.delta, check.format),
  )}</span> <span class="muted">${escapeHtml(formatPercent(check.deltaPct))}</span>`;
}

function budgetCell(check: Check): string {
  if (check.max === undefined) return '<span class="muted">—</span>';
  return escapeHtml(formatValue(check.max, check.format));
}

function renderChecks(entry: ReportEntry): string {
  const rows = entry.checks
    .map(
      (check) => `<tr>
        <td class="metric">${escapeHtml(check.label)}</td>
        <td class="value">${escapeHtml(check.formatted)}</td>
        <td>${deltaCell(check)}</td>
        <td class="muted">${budgetCell(check)}</td>
        <td>${statusPill(check)}</td>
      </tr>`,
    )
    .join('');

  const notes = entry.checks
    .map((check) => ({ label: check.label, reason: noteworthyReason(check) }))
    .filter((note): note is { label: string; reason: string } => note.reason !== undefined)
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

function renderRequests(entry: ReportEntry): string {
  const requests = entry.audit.heaviest;
  if (requests.length === 0) {
    return `<section class="card"><h3>Heaviest requests</h3><p class="muted">No requests captured.</p></section>`;
  }
  const max = Math.max(...requests.map((request) => request.bytes), 1);

  const rows = requests
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
            request.thirdParty ? ' · <span class="third">3rd party</span>' : ''
          }</span>
        </div>
        <div class="bar"><span style="width:${width}%"></span></div>
      </li>`;
    })
    .join('');

  return `<section class="card">
    <h3>Heaviest requests</h3>
    <ul class="reqs">${rows}</ul>
  </section>`;
}

function renderA11y(entry: ReportEntry): string {
  const violations = entry.audit.violations;
  if (violations.length === 0) {
    return `<section class="card"><h3>Accessibility</h3><p class="ok">No axe violations found.</p></section>`;
  }

  const nodes = violations.reduce((total, violation) => total + Math.max(violation.nodes.length, 1), 0);
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
    <h3>Accessibility <span class="muted">${nodes} node${nodes === 1 ? '' : 's'}</span></h3>
    ${rows}
  </section>`;
}

function renderEntry(entry: ReportEntry): string {
  const meta = [
    entry.audit.preset,
    `${entry.audit.runs} run${entry.audit.runs === 1 ? '' : 's'}`,
    entry.baseline ? 'compared to baseline' : 'no baseline',
  ].join(' · ');

  return `<section class="report">
    <div class="report-head">
      <h2>${escapeHtml(entry.url)}</h2>
      <p class="muted">${escapeHtml(meta)}</p>
    </div>
    ${renderChecks(entry)}
    <div class="grid">
      ${renderLcp(entry)}
      ${renderRequests(entry)}
    </div>
    ${renderA11y(entry)}
  </section>`;
}

export function renderHtml(report: PulseReport): string {
  const summary = [
    `<span class="chip fail"><strong>${report.failed}</strong> failed</span>`,
    `<span class="chip warn"><strong>${report.warned}</strong> warned</span>`,
    `<span class="chip pass"><strong>${report.passed}</strong> passed</span>`,
  ].join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pulse audit — ${escapeHtml(report.results.map((entry) => entry.url).join(', '))}</title>
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
  .muted { color: var(--muted); font-weight: 400; }
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
  .notes { margin: 8px 0 0; padding-left: 18px; font-size: 12.5px; color: var(--muted); }
  .notes li { margin-bottom: 3px; }
  .delta.up { color: var(--fail); } .delta.down { color: var(--pass); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .pill.pass { color: var(--pass); background: color-mix(in srgb, var(--pass) 12%, transparent); }
  .pill.fail { color: var(--fail); background: color-mix(in srgb, var(--fail) 12%, transparent); }
  .pill.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin-top: 14px; }
  .card { min-width: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-top: 14px; }
  .grid .card { margin-top: 0; }
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
  .third { color: var(--warn); }
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
    .checks th:nth-child(3), .checks td:nth-child(3) { display: none; }
    .checks th, .checks td { padding: 10px 8px; }
    .checks .value, .checks td:nth-child(4) { white-space: nowrap; }
    h1 { font-size: 24px; }
  }
</style>
</head>
<body>
<div class="page">
  <header>
    <div class="brand"><span class="dot"></span>pulse audit</div>
    <h1>Performance, accessibility &amp; weight report</h1>
    <p class="muted">${report.preset} · ${report.runs} run${report.runs === 1 ? '' : 's'} · ${escapeHtml(
      new Date(report.generatedAt).toLocaleString('en-GB'),
    )}</p>
    <div style="margin-top:14px">${summary}</div>
  </header>
  ${report.results.map(renderEntry).join('')}
  <footer>Generated by pulse-audit v${escapeHtml(report.version)} · budgets are compared to the baseline captured on the same preset and run count.</footer>
</div>
</body>
</html>`;
}

export async function writeHtmlReport(report: PulseReport, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, 'report.html');
  await writeFile(path, renderHtml(report), 'utf8');
  return path;
}
