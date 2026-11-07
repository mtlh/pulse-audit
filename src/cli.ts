#!/usr/bin/env node
import { access, appendFile } from 'node:fs/promises';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  baselineKey,
  baselinePath,
  comparableBaseline,
  mergeBaseline,
  pruneBaseline,
  readBaseline,
  writeBaseline,
} from './baseline.js';
import {
  budgetsFromResult,
  configSchema,
  defaultConfig,
  loadConfig,
  PulseConfigError,
  resolveTargets,
  targetUrl,
  writeConfig,
} from './config.js';
import { runDoctor, type DoctorCheck } from './doctor.js';
import { formatValue, type ValueFormat } from './format.js';
import { buildReport, type ReportInput } from './report.js';
import { writeHtmlReport } from './reporters/html.js';
import { writeJsonReport } from './reporters/json.js';
import { renderMarkdown, upsertSummary } from './reporters/summary.js';
import { printReport } from './reporters/terminal.js';
import { runAudit } from './runner.js';
import type { Preset, PulseConfig, WarmupMode } from './types.js';
import { VERSION } from './version.js';

type FailOn = 'error' | 'warn' | 'none';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseInteger(value: string | undefined, flag: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseRuns(value: string | undefined): number | undefined {
  return parseInteger(value, '--runs', 1, 10);
}

function parseRetries(value: string | undefined): number | undefined {
  return parseInteger(value, '--retries', 0, 10);
}

function parseTimeout(value: string | undefined): number | undefined {
  return parseInteger(value, '--timeout', 1, 3_600_000);
}

function parsePreset(value: string | undefined): Preset | undefined {
  if (value === undefined) return undefined;
  if (value !== 'mobile' && value !== 'desktop') {
    throw new Error('--preset must be "mobile" or "desktop"');
  }
  return value;
}

function parseWarmup(value: string | undefined): WarmupMode | undefined {
  if (value === undefined) return undefined;
  if (value !== 'full' && value !== 'navigate' && value !== 'none') {
    throw new Error('--warmup must be "full", "navigate" or "none"');
  }
  return value;
}

/** The positional audit URL bypasses config validation, so check it here too. */
function assertHttpUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`"${value}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`"${value}" must use http:// or https://`);
  }
}

function parseFailOn(value: string | undefined, noFail: boolean | undefined): FailOn {
  if (noFail === false) return 'none';
  if (value === undefined) return 'error';
  if (value !== 'error' && value !== 'warn' && value !== 'none') {
    throw new Error('--fail-on must be one of: error, warn, none');
  }
  return value;
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - value.length));
}

function metricRow(label: string, measured: string, budget: string): string {
  return `  ${pad(label, 22)}${pad(measured, 12)}${budget}`;
}

const program = new Command();

program
  .name('pulse')
  .description('Performance, accessibility and page-weight budgets that survive CI.')
  .version(VERSION);

program
  .command('init')
  .description('Create a .pulse.json config')
  .argument('[urls...]', 'URLs to audit')
  .option('--from <url>', 'measure this URL and derive the initial budgets')
  .option('--out <path>', 'config path', '.pulse.json')
  .option('--force', 'overwrite an existing config')
  .action(async (urls: string[], options: { from?: string; out: string; force?: boolean }) => {
    const list = urls.length > 0 ? urls : options.from ? [options.from] : [];
    if (list.length === 0) {
      throw new Error('Provide at least one URL, for example: pulse init https://example.com');
    }

    if (!options.force && (await exists(options.out))) {
      throw new Error(`${options.out} already exists. Use --force to overwrite it.`);
    }

    for (const url of list) assertHttpUrl(url);
    if (options.from) assertHttpUrl(options.from);

    let config = configSchema.parse(defaultConfig(list)) as PulseConfig;

    if (options.from) {
      const measured = await runAudit(options.from, {
        preset: config.preset,
        runs: config.runs,
        retries: config.retries,
        timeoutMs: config.timeoutMs,
        warmup: config.warmup,
      });
      config = { ...config, budgets: budgetsFromResult(measured) };

      const budgets = config.budgets;
      const metrics = measured.metrics;
      const rows: Array<{
        label: string;
        value: number;
        max: number | undefined;
        format: ValueFormat;
      }> = [
        { label: 'LCP', value: metrics.lcp, max: budgets.lcp?.max, format: 'ms' },
        { label: 'CLS', value: metrics.cls, max: budgets.cls?.max, format: 'score' },
        { label: 'TBT', value: metrics.tbt, max: budgets.tbt?.max, format: 'ms' },
        { label: 'FCP', value: metrics.fcp, max: budgets.fcp?.max, format: 'ms' },
        { label: 'TTFB', value: metrics.ttfb, max: budgets.ttfb?.max, format: 'ms' },
        { label: 'JavaScript', value: metrics.js, max: budgets.js?.max, format: 'bytes' },
        { label: 'CSS', value: metrics.css, max: budgets.css?.max, format: 'bytes' },
        { label: 'Fonts', value: metrics.fonts, max: budgets.fonts?.max, format: 'bytes' },
        { label: 'Images', value: metrics.images, max: budgets.images?.max, format: 'bytes' },
        { label: 'Total', value: metrics.total, max: budgets.total?.max, format: 'bytes' },
        { label: 'Requests', value: metrics.requests, max: budgets.requests?.max, format: 'count' },
        {
          label: 'Third-party bytes',
          value: metrics.thirdPartyBytes,
          max: budgets.thirdPartyBytes?.max,
          format: 'bytes',
        },
        {
          label: 'Third-party requests',
          value: metrics.thirdPartyRequests,
          max: budgets.thirdPartyRequests?.max,
          format: 'count',
        },
        { label: 'A11y nodes', value: metrics.violations, max: budgets.a11y?.maxViolations, format: 'count' },
      ];

      console.error(
        pc.dim(
          `measured ${options.from} (${config.runs} run${config.runs === 1 ? '' : 's'}, ${config.warmup ?? 'navigate'} warm-up)`,
        ),
      );
      console.log('');
      console.log(pc.dim(`  ${pad('metric', 22)}${pad('measured', 12)}budget`));
      for (const row of rows) {
        console.log(
          metricRow(row.label, formatValue(row.value, row.format), formatValue(row.max ?? 0, row.format)),
        );
      }
      console.log('');
    }

    await writeConfig(options.out, config);

    console.log(`${pc.green('created')} ${options.out}`);
    console.log('');
    console.log('Next:');
    console.log(
      `  1. ${pc.bold('npx @mtlh/pulse-audit audit --update-baseline')}  (first run establishes the baseline)`,
    );
    console.log(`  2. Review ${pc.bold('.pulse/report.html')} and tighten the budgets`);
    console.log(`  3. Run ${pc.bold('npx @mtlh/pulse-audit audit')} in CI and keep the baseline`);
  });

program
  .command('audit')
  .description('Audit one or more URLs and compare against a baseline')
  .argument('[url]', 'override the URL from the config')
  .option('-c, --config <path>', 'config path', '.pulse.json')
  .option('-r, --runs <n>', 'measured runs; one warm-up is discarded and the median is used')
  .option('--preset <preset>', 'mobile or desktop')
  .option('--baseline <path>', 'baseline file to compare against')
  .option('--out <dir>', 'report output directory')
  .option('--summary <path>', 'write a Markdown summary to this file (the pulse block is replaced)')
  .option('--retries <n>', 'extra attempts after a failed Lighthouse run')
  .option('--timeout <ms>', 'Lighthouse maxWaitForLoad in milliseconds')
  .option('--warmup <mode>', 'warm-up before measured runs: navigate, full or none')
  .option('--github-output', 'write report-path and counts to $GITHUB_OUTPUT')
  .option('--update-baseline', 'write the audit result to the baseline file')
  .option('--json', 'print the report JSON to stdout; progress and paths go to stderr')
  .option('--quiet', 'suppress the table and paths')
  .option('--fail-on <level>', 'error, warn or none', 'error')
  .option('--no-fail', 'always exit 0, even when budgets fail')
  .action(
    async (
      url: string | undefined,
      options: {
        config: string;
        runs?: string;
        preset?: string;
        baseline?: string;
        out?: string;
        summary?: string;
        retries?: string;
        timeout?: string;
        warmup?: string;
        githubOutput?: boolean;
        updateBaseline?: boolean;
        json?: boolean;
        quiet?: boolean;
        failOn?: string;
        fail?: boolean;
      },
    ) => {
      if (url !== undefined) assertHttpUrl(url);
      const config: PulseConfig = await loadConfig(options.config);

      const runs = parseRuns(options.runs);
      const preset = parsePreset(options.preset);
      const retries = parseRetries(options.retries);
      const timeoutMs = parseTimeout(options.timeout);
      const warmup = parseWarmup(options.warmup);
      const failOn = parseFailOn(options.failOn, options.fail);

      if (runs !== undefined) config.runs = runs;
      if (preset !== undefined) config.preset = preset;
      if (retries !== undefined) config.retries = retries;
      if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
      if (warmup !== undefined) config.warmup = warmup;
      if (options.out !== undefined) config.report.outDir = options.out;
      if (url !== undefined) {
        // Keep the page-level overrides when the override URL is already in the
        // config; a bare string would silently drop its budget block.
        const existing = config.urls.find(
          (target) => (typeof target === 'string' ? target : target.url) === url,
        );
        config.urls = [existing ?? url];
      }

      const pages = resolveTargets(config);
      // An explicit CLI override is a global decision: it should win over a
      // page-level preset/runs entry too.
      if (runs !== undefined) for (const page of pages) page.runs = runs;
      if (preset !== undefined) for (const page of pages) page.preset = preset;

      const quiet = options.quiet === true;
      const json = options.json === true;
      const progress = (text: string): void => {
        if (!quiet && !json) console.error(pc.dim(text));
      };
      const warn = (text: string): void => {
        if (!quiet) console.error(pc.yellow(text));
      };
      const writeInfo = (text: string): void => {
        if (quiet) return;
        if (json) console.error(text);
        else console.log(text);
      };

      const baselineFile = options.baseline ?? baselinePath(config.report.outDir);
      const baseline = await readBaseline(baselineFile);

      if (Object.keys(baseline.results).length === 0) {
        warn(
          `No baseline at ${baselineFile}. Absolute budgets still apply; use --update-baseline to establish one.`,
        );
      }

      const inputs: ReportInput[] = [];
      const errors: Array<{ url: string; message: string }> = [];

      for (const page of pages) {
        const pageUrl = targetUrl(page);
        progress(
          `auditing ${pageUrl} (${page.preset}, ${page.runs} run${page.runs === 1 ? '' : 's'}, ${page.warmup ?? 'navigate'} warm-up)…`,
        );

        try {
          const result = await runAudit(pageUrl, {
            preset: page.preset,
            runs: page.runs,
            retries: page.retries,
            timeoutMs: page.timeoutMs,
            warmup: page.warmup,
          });

          const raw = baseline.results[baselineKey(page.preset, pageUrl)];
          const comparable = comparableBaseline(raw, result);
          if (raw && !comparable) {
            warn(
              `Ignoring baseline for ${pageUrl}: preset, run count or Lighthouse version changed (${page.preset}).`,
            );
          }

          inputs.push({ result, baseline: comparable, config: page });
        } catch (error) {
          errors.push({
            url: pageUrl,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const report = buildReport(inputs);
      const jsonPath = await writeJsonReport(report, config.report.outDir);
      const htmlPath = await writeHtmlReport(report, config.report.outDir);

      if (!json && !quiet && inputs.length > 0) {
        printReport(report);
        console.log('');
      }

      writeInfo(`${pc.dim('json')}  ${jsonPath}`);
      writeInfo(`${pc.dim('html')}  ${htmlPath}`);

      if (options.updateBaseline) {
        if (errors.length > 0) {
          warn('Baseline not updated: at least one URL failed to audit, and a partial baseline is unsafe.');
        } else {
          await writeBaseline(
            baselineFile,
            mergeBaseline(
              baseline,
              inputs.map((input) => input.result),
            ),
          );
          writeInfo(`${pc.dim('baseline')} ${baselineFile}`);
        }
      }

      if (options.summary) {
        await upsertSummary(options.summary, renderMarkdown(report));
        writeInfo(`${pc.dim('summary')} ${options.summary}`);
      }

      if (options.githubOutput) {
        const outputPath = process.env.GITHUB_OUTPUT;
        if (!outputPath) {
          warn('--github-output was passed but GITHUB_OUTPUT is not set.');
        } else {
          const hasFailure = report.failed > 0 || errors.length > 0;
          await appendFile(
            outputPath,
            [
              `report-path=${htmlPath}`,
              `failed=${hasFailure}`,
              `failed-count=${report.failed}`,
              `warned-count=${report.warned}`,
              `audit-errors=${errors.length}`,
              '',
            ].join('\n'),
            'utf8',
          );
        }
      }

      if (json) console.log(JSON.stringify(report, null, 2));

      if (errors.length > 0) {
        for (const error of errors) {
          console.error(pc.red(`could not audit ${error.url}: ${error.message}`));
        }
        console.error(pc.red(`${errors.length} URL${errors.length === 1 ? '' : 's'} could not be audited.`));
        process.exitCode = 2;
        return;
      }

      if (failOn === 'warn' && report.warned > 0) {
        console.error(
          pc.yellow(
            `${report.warned} check${report.warned === 1 ? '' : 's'} warned and --fail-on warn is set.`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      if (failOn !== 'none' && report.failed > 0) {
        console.error(pc.red(`${report.failed} check${report.failed === 1 ? '' : 's'} failed.`));
        process.exitCode = 1;
      }
    },
  );

const baselineCommand = program.command('baseline').description('Inspect or prune the saved baseline');

baselineCommand
  .command('show')
  .description('Show what the baseline contains')
  .option('--baseline <path>', 'baseline file', '.pulse/baseline.json')
  .action(async (options: { baseline: string }) => {
    const file = await readBaseline(options.baseline);
    const entries = Object.entries(file.results);

    if (entries.length === 0) {
      console.log(`No baseline results in ${options.baseline}.`);
      console.log('Run "pulse audit --update-baseline" to establish one.');
      return;
    }

    for (const [key, result] of entries) {
      const lcp = typeof result.metrics?.lcp === 'number' ? formatValue(result.metrics.lcp, 'ms') : '—';
      console.log(pc.bold(result.url ?? key));
      console.log(`  ${pad('preset', 12)}${result.preset ?? '—'}`);
      console.log(`  ${pad('capturedAt', 12)}${result.capturedAt ?? '—'}`);
      console.log(`  ${pad('runs', 12)}${result.runs ?? '—'}`);
      console.log(`  ${pad('LCP', 12)}${lcp}`);
      console.log(`  ${pad('Lighthouse', 12)}${result.lighthouseVersion ?? 'unknown'}`);
      console.log('');
    }
  });

baselineCommand
  .command('prune')
  .description('Remove baseline entries that are no longer in the config')
  .option('-c, --config <path>', 'config path', '.pulse.json')
  .option('--baseline <path>', 'baseline file (defaults to the config report outDir)')
  .option('--dry-run', 'show what would be removed without writing')
  .action(async (options: { config: string; baseline?: string; dryRun?: boolean }) => {
    // Load the config first: a broken config must never authorise a prune.
    const config = await loadConfig(options.config);
    const file = options.baseline ?? baselinePath(config.report.outDir);
    const baseline = await readBaseline(file);

    const keep = new Set(resolveTargets(config).map((page) => baselineKey(page.preset, targetUrl(page))));
    const removed = Object.keys(baseline.results).filter((key) => !keep.has(key));

    if (removed.length === 0) {
      console.log(`No stale baseline entries in ${file}.`);
      return;
    }

    if (!options.dryRun) {
      await writeBaseline(file, pruneBaseline(baseline, keep));
    }

    console.log(
      options.dryRun
        ? `Would remove ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} from ${file}:`
        : `Removed ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} from ${file}:`,
    );
    for (const key of removed) console.log(`  ${key}`);
  });

program
  .command('doctor')
  .description('Check Node, Chrome, config, baseline, report directory and URLs')
  .option('-c, --config <path>', 'config path', '.pulse.json')
  .option('--baseline <path>', 'baseline file (defaults to the config report outDir)')
  .option('--skip-network', 'skip URL reachability checks')
  .action(async (options: { config: string; baseline?: string; skipNetwork?: boolean }) => {
    const result = await runDoctor({
      configPath: options.config,
      baselinePath: options.baseline,
      skipNetwork: options.skipNetwork === true,
    });

    const marker: Record<DoctorCheck['status'], string> = {
      pass: pc.green('✓'),
      warn: pc.yellow('!'),
      fail: pc.red('✗'),
    };

    for (const check of result.checks) {
      console.log(`${marker[check.status]} ${pad(check.name, 28)} ${pc.dim(check.detail)}`);
    }

    if (!result.ok) {
      console.error(pc.red('Doctor found problems that will prevent a trustworthy audit.'));
      process.exitCode = 1;
    } else if (result.checks.some((check) => check.status === 'warn')) {
      console.log(pc.yellow('Doctor checks passed with warnings.'));
    } else {
      console.log(pc.green('Doctor checks passed.'));
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof PulseConfigError) {
    console.error(pc.red(error.message));
  } else {
    console.error(pc.red(`pulse: ${(error as Error).message}`));
  }
  process.exitCode = 2;
});
