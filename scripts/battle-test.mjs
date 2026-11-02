import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = process.cwd();
const cli = path.join(repo, 'dist/cli.js');
const url = 'https://mtlh.vercel.app/';
const work = await mkdtemp(path.join(tmpdir(), 'pulse-battle-'));
const results = [];

function run(label, args, env = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, ...args],
      {
        cwd: work,
        env: { ...process.env, NO_COLOR: '1', ...env },
        timeout: 600_000,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const result = {
          label,
          command: `node dist/cli.js ${args.join(' ')}`,
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout,
          stderr,
          ms: Date.now() - started,
        };
        results.push(result);
        console.log(`\n[${label}] exit ${result.code} in ${(result.ms / 1000).toFixed(1)}s`);
        if (result.stderr.trim()) console.log(result.stderr.trim());
        resolve(result);
      },
    );
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 1. A user defines minimums from a real page.
const initialized = await run('init --from', ['init', '--from', url, '--out', 'derived.json', '--force']);
assert(initialized.code === 0, 'init --from failed');
const derived = JSON.parse(await readFile(path.join(work, 'derived.json'), 'utf8'));

// 2. Main-branch CI: update the baseline without gating on inherited debt.
await copyFile(path.join(repo, '.pulse.json'), path.join(work, '.pulse.json'));
const summary = path.join(work, 'summary.md');
const updateOutput = path.join(work, 'github-output-update.txt');
const compareOutput = path.join(work, 'github-output-compare.txt');
const update = await run(
  'ci: update baseline',
  ['audit', url, '--config', '.pulse.json', '--runs', '3', '--summary', summary, '--github-output', '--update-baseline', '--no-fail'],
  { GITHUB_OUTPUT: updateOutput, GITHUB_STEP_SUMMARY: summary },
);
assert(update.code === 0, 'baseline update failed');
assert((await stat(path.join(work, '.pulse/baseline.json'))).isFile(), 'baseline was not written');

// 3. Pull-request CI: compare against the saved baseline.
const compare = await run(
  'ci: compare',
  ['audit', url, '--config', '.pulse.json', '--runs', '3', '--summary', summary, '--github-output'],
  { GITHUB_OUTPUT: compareOutput, GITHUB_STEP_SUMMARY: summary },
);
assert(compare.code === 0, 'comparison failed');
const report = JSON.parse(await readFile(path.join(work, '.pulse/report.json'), 'utf8'));
const audit = report.results[0].audit;
const checks = report.results[0].checks;
const deltas = checks.filter((check) => check.delta !== undefined);

// 4. A page that regresses must fail the gate.
const regressed = JSON.parse(await readFile(path.join(work, '.pulse/baseline.json'), 'utf8'));
regressed.results[url].metrics.lcp = 1200;
regressed.results[url].metrics.requests = 10;
await writeFile(path.join(work, 'baseline-regressed.json'), JSON.stringify(regressed, null, 2));
const fail = await run('forced regression', [
  'audit', url,
  '--config', '.pulse.json',
  '--runs', '3',
  '--baseline', 'baseline-regressed.json',
]);
assert(fail.code === 1, `expected exit 1 for a regression, got ${fail.code}`);
const failReport = JSON.parse(await readFile(path.join(work, '.pulse/report.json'), 'utf8'));
assert(failReport.failed >= 2, 'expected at least two failing checks');

const htmlSize = (await stat(path.join(work, '.pulse/report.html'))).size;
const outputText = await readFile(compareOutput, 'utf8');
const summaryText = await readFile(summary, 'utf8');

const lines = [
  '# Pulse battle test',
  '',
  `- Date: ${new Date().toISOString()}`,
  `- URL: ${url}`,
  `- Workdir: \`${work}\``,
  '',
  '## Derived minimums (`pulse init --from`)',
  '',
  '| Metric | Budget |',
  '| --- | ---: |',
  `| LCP | ${derived.budgets.lcp.max} ms |`,
  `| CLS | ${derived.budgets.cls.max} |`,
  `| TBT | ${derived.budgets.tbt.max} ms (${derived.budgets.tbt.severity}) |`,
  `| JavaScript | ${derived.budgets.js.max} B |`,
  `| Images | ${derived.budgets.images.max} B |`,
  `| Requests | ${derived.budgets.requests.max} |`,
  `| A11y | ${derived.budgets.a11y.maxViolations} total, ${derived.budgets.a11y.maxNew} new |`,
  '',
  '## Verified run',
  '',
  '| Metric | Value | Budget | Status |',
  '| --- | ---: | ---: | --- |',
  ...checks.map(
    (check) =>
      `| ${check.label} | ${check.formatted} | ${check.max ?? '—'} | ${check.status} |`,
  ),
  '',
  `Report: ${htmlSize} B · deltas: ${deltas.length} · GITHUB_OUTPUT: ${outputText.trim().replace(/\n/g, ', ')}`,
  `Summary contains table: ${summaryText.includes('| Check | Result |')}`,
  '',
  '## Flows',
  '',
  '| Flow | Exit | Duration |',
  '| --- | ---: | ---: |',
  ...results.map((result) => `| ${result.label} | ${result.code} | ${(result.ms / 1000).toFixed(1)}s |`),
  '',
  '## Forced regression',
  '',
  `Exit ${fail.code}; failed checks: ${failReport.failed}.`,
  '',
  ...failReport.results[0].checks
    .filter((check) => check.status !== 'pass')
    .map((check) => `- **${check.label}**: ${check.reason}`),
  '',
].join('\n');

await mkdir(path.join(repo, '.pulse'), { recursive: true });
const reportPath = path.join(repo, '.pulse/battle-test.md');
await writeFile(reportPath, lines, 'utf8');

console.log('\n--- battle test summary ---');
console.log(`LCP ${audit.metrics.lcp.toFixed(0)}ms · CLS ${audit.metrics.cls} · TBT ${audit.metrics.tbt}ms`);
console.log(`JS ${audit.metrics.js}B · Images ${audit.metrics.images}B · Requests ${audit.metrics.requests}`);
console.log(`A11y ${audit.metrics.violations} nodes · report ${htmlSize}B · deltas ${deltas.length}`);
console.log(`forced regression exit ${fail.code} with ${failReport.failed} failed checks`);
console.log(`report written to ${reportPath}`);
