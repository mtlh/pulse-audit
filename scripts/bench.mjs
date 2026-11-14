#!/usr/bin/env node
/**
 * Per-phase benchmark for Pulse's audit pipeline.
 *
 *   npm run build
 *   node scripts/bench.mjs --url https://example.com/ --runs 3
 *   node scripts/bench.mjs --config .pulse.json --concurrency 2 --json
 *
 * It creates one Chrome session, audits every target, and prints the time spent
 * in Chrome/module startup, each warm-up, each measured run, report assembly and
 * browser shutdown, plus the resulting metrics.
 */
import { performance } from 'node:perf_hooks';

function parseArgs(argv) {
  const options = {
    urls: [],
    runs: undefined,
    concurrency: undefined,
    warmup: undefined,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === '--url') options.urls.push(next());
    else if (arg === '--config') options.config = next();
    else if (arg === '--fixture') options.fixture = Number(next());
    else if (arg === '--runs') options.runs = Number(next());
    else if (arg === '--concurrency') options.concurrency = Number(next());
    else if (arg === '--warmup') options.warmup = next();
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(`Usage: node scripts/bench.mjs --url <url> [...] [--runs 3] [--concurrency 2]
       node scripts/bench.mjs --config .pulse.json [--runs 3] [--concurrency 2]
       npx tsx scripts/bench.mjs --fixture 4 [--runs 3] [--concurrency 2]`);
  process.exit(0);
}
if (options.fixture !== undefined) {
  if (!Number.isInteger(options.fixture) || options.fixture < 1) {
    console.error('--fixture must be a positive URL count.');
    process.exit(2);
  }
  try {
    const { startFixture } = await import('../test/flows/fixture.ts');
    const site = await startFixture();
    options.urls = Array.from({ length: options.fixture }, (_, index) => `${site.url}?bench=${index + 1}`);
    options.fixtureSite = site;
  } catch (error) {
    console.error(`--fixture needs tsx: npx tsx scripts/bench.mjs --fixture 4\n${error.message}`);
    process.exit(2);
  }
}

if (options.urls.length === 0 && !options.config) {
  console.error('Provide --config <path>, --fixture <n> or at least one --url <url>.');
  process.exit(2);
}

let pulse;
try {
  pulse = await import('../dist/index.js');
} catch (error) {
  console.error(`Could not load dist/index.js. Run "npm run build" first.\n${error.message}`);
  process.exit(2);
}

const {
  auditTargets,
  buildReport,
  createAuditSession,
  defaultConfig,
  loadConfig,
  resolveTargets,
  targetUrl,
} = pulse;

let pages;
if (options.config) {
  const config = await loadConfig(options.config);
  if (options.runs !== undefined) config.runs = options.runs;
  if (options.concurrency !== undefined) config.concurrency = options.concurrency;
  if (options.warmup !== undefined) config.warmup = options.warmup;
  pages = resolveTargets(config);
} else {
  const config = defaultConfig(options.urls);
  if (options.runs !== undefined) config.runs = options.runs;
  if (options.concurrency !== undefined) config.concurrency = options.concurrency;
  if (options.warmup !== undefined) config.warmup = options.warmup;
  pages = resolveTargets(config);
}

const concurrency = options.concurrency ?? pages[0]?.concurrency ?? 1;
const timings = new Map();

const startedSession = performance.now();
// Concurrency > 1 runs in worker lanes, each with its own Chrome, so the main
// thread does not need a session.
const session = concurrency === 1 ? await createAuditSession() : undefined;
const sessionMs = performance.now() - startedSession;

const targets = pages.map((page) => {
  const url = targetUrl(page);
  const record = { url, warmupMs: 0, runMs: [], metrics: undefined };
  timings.set(url, record);

  return {
    url,
    options: {
      preset: page.preset,
      runs: page.runs,
      retries: page.retries,
      timeoutMs: page.timeoutMs,
      auth: page.auth,
      warmup: page.warmup,
    },
  };
});

const startedAudit = performance.now();
const outcomes = await auditTargets(session, targets, {
  concurrency,
  onProgress: (event) => {
    if (event.status !== 'done' && event.status !== 'failed') return;
    const record = timings.get(event.url);
    if (!record) return;
    if (event.phase === 'warmup') record.warmupMs = event.durationMs ?? 0;
    else if (event.durationMs !== undefined) record.runMs.push(event.durationMs);
  },
});
const auditMs = performance.now() - startedAudit;
for (const outcome of outcomes) {
  if (outcome.status === 'ok') timings.get(outcome.url).metrics = outcome.result.metrics;
}

const startedClose = performance.now();
await session?.close();
const closeMs = performance.now() - startedClose;

const inputs = outcomes.flatMap((outcome, index) => {
  if (outcome.status !== 'ok') return [];
  return [{ result: outcome.result, baseline: null, config: pages[index] }];
});
const startedReport = performance.now();
buildReport(inputs);
const reportMs = performance.now() - startedReport;

const failed = outcomes.filter((outcome) => outcome.status === 'error');
const result = {
  targets: outcomes.map((outcome, index) => {
    const url = outcome.url;
    const record = timings.get(url);
    return {
      url,
      status: outcome.status,
      error: outcome.status === 'error' ? outcome.error : undefined,
      warmupMs: Math.round(record.warmupMs),
      runMs: record.runMs.map(Math.round),
      auditMs: Math.round(record.warmupMs + record.runMs.reduce((sum, ms) => sum + ms, 0)),
      metrics:
        outcome.status === 'ok'
          ? {
              lcp: outcome.result.metrics.lcp,
              cls: outcome.result.metrics.cls,
              tbt: outcome.result.metrics.tbt,
              fcp: outcome.result.metrics.fcp,
              ttfb: outcome.result.metrics.ttfb,
              js: outcome.result.metrics.js,
              total: outcome.result.metrics.total,
              requests: outcome.result.metrics.requests,
            }
          : undefined,
      index: index + 1,
    };
  }),
  runs: pages[0]?.runs,
  concurrency,
  warmup: pages[0]?.warmup ?? 'navigate',
  sessionMs: Math.round(sessionMs),
  auditMs: Math.round(auditMs),
  closeMs: Math.round(closeMs),
  reportMs: Number(reportMs.toFixed(2)),
  totalMs: Math.round(sessionMs + auditMs + closeMs + reportMs),
};

if (options.json) {
  console.log(JSON.stringify(result, null, 2));
  await options.fixtureSite?.close();
  process.exit(failed.length > 0 ? 2 : 0);
}

const ms = (value) => `${Math.round(value)}ms`;
console.log('Pulse benchmark');
console.log(
  `  ${pages.length} target(s) · ${result.runs} run(s) · concurrency ${concurrency} · ${result.warmup} warm-up`,
);
console.log(
  `  ${concurrency === 1 ? 'chrome + lighthouse import ' : 'main-thread setup        '}  ${ms(sessionMs)}`,
);
console.log(`  audit wall clock            ${ms(auditMs)}`);
console.log(`  browser close               ${ms(closeMs)}`);
console.log(`  report assembly             ${reportMs.toFixed(2)}ms`);
console.log(`  total                       ${ms(result.totalMs)}`);
console.log('');
console.log('  #  URL                              warmup   runs                 total');
for (const target of result.targets) {
  const runs = target.runMs.map((value) => ms(value)).join(' + ') || '—';
  console.log(
    `  ${String(target.index).padStart(2)} ${target.url.padEnd(32)} ${ms(target.warmupMs).padStart(7)}  ${runs.padEnd(20)} ${ms(target.auditMs).padStart(7)}`,
  );
}
console.log('');
console.log('  #  LCP      CLS     TBT    FCP     TTFB    JS       total    requests');
for (const target of result.targets) {
  if (!target.metrics) {
    console.log(`  ${String(target.index).padStart(2)} FAILED: ${target.error}`);
    continue;
  }
  const metrics = target.metrics;
  console.log(
    `  ${String(target.index).padStart(2)} ${`${Math.round(metrics.lcp)}ms`.padEnd(8)} ${String(
      metrics.cls,
    ).padEnd(7)} ${`${Math.round(metrics.tbt)}ms`.padEnd(6)} ${`${Math.round(metrics.fcp)}ms`.padEnd(
      7,
    )} ${`${Math.round(metrics.ttfb)}ms`.padEnd(7)} ${`${metrics.js}B`.padEnd(8)} ${`${metrics.total}B`.padEnd(
      8,
    )} ${metrics.requests}`,
  );
}

await options.fixtureSite?.close();
if (failed.length > 0) {
  console.error(`\n${failed.length} target(s) failed.`);
  process.exit(2);
}
