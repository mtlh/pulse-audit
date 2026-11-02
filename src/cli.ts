#!/usr/bin/env node
import { access, appendFile } from 'node:fs/promises';
import { Command } from 'commander';
import pc from 'picocolors';
import { baselinePath, comparableBaseline, mergeBaseline, readBaseline, writeBaseline } from './baseline.js';
import {
  budgetsFromResult,
  configSchema,
  defaultConfig,
  loadConfig,
  PulseConfigError,
  writeConfig,
} from './config.js';
import { formatValue } from './format.js';
import { buildReport } from './report.js';
import { writeHtmlReport } from './reporters/html.js';
import { writeJsonReport } from './reporters/json.js';
import { renderMarkdown } from './reporters/summary.js';
import { printReport } from './reporters/terminal.js';
import { runAudit } from './runner.js';
import type { Preset, PulseConfig } from './types.js';

const VERSION = '0.1.0';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseRuns(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const runs = Number.parseInt(value, 10);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
    throw new Error('--runs must be an integer between 1 and 10');
  }
  return runs;
}

function parsePreset(value: string | undefined): Preset | undefined {
  if (value === undefined) return undefined;
  if (value !== 'mobile' && value !== 'desktop') {
    throw new Error('--preset must be "mobile" or "desktop"');
  }
  return value;
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

    let config = configSchema.parse(defaultConfig(list)) as PulseConfig;

    if (options.from) {
      const measured = await runAudit(options.from, { ...config, runs: 1 });
      config = { ...config, budgets: budgetsFromResult(measured) };
      const budgets = config.budgets;

      console.error(pc.dim(`measured ${options.from} (1 run + warm-up)`));
      console.log('');
      console.log(pc.dim('  metric        measured    budget'));
      console.log(
        `  LCP           ${formatValue(measured.metrics.lcp, 'ms').padEnd(12)}${formatValue(
          budgets.lcp?.max ?? 0,
          'ms',
        )}`,
      );
      console.log(
        `  CLS           ${formatValue(measured.metrics.cls, 'score').padEnd(12)}${formatValue(
          budgets.cls?.max ?? 0,
          'score',
        )}`,
      );
      console.log(
        `  TBT           ${formatValue(measured.metrics.tbt, 'ms').padEnd(12)}${formatValue(
          budgets.tbt?.max ?? 0,
          'ms',
        )}`,
      );
      console.log(
        `  JavaScript    ${formatValue(measured.metrics.js, 'bytes').padEnd(12)}${formatValue(
          budgets.js?.max ?? 0,
          'bytes',
        )}`,
      );
      console.log(
        `  Images        ${formatValue(measured.metrics.images, 'bytes').padEnd(12)}${formatValue(
          budgets.images?.max ?? 0,
          'bytes',
        )}`,
      );
      console.log(
        `  Requests      ${String(measured.metrics.requests).padEnd(12)}${budgets.requests?.max ?? 0}`,
      );
      console.log(
        `  A11y nodes    ${String(measured.metrics.violations).padEnd(12)}${budgets.a11y?.maxViolations ?? 0}`,
      );
      console.log('');
    }

    await writeConfig(options.out, config);

    console.log(`${pc.green('created')} ${options.out}`);
    console.log('');
    console.log('Next:');
    console.log(`  1. ${pc.bold('npx pulse audit --update-baseline')}  (first run establishes the baseline)`);
    console.log(`  2. Review ${pc.bold('.pulse/report.html')} and tighten the budgets`);
    console.log(`  3. Run ${pc.bold('npx pulse-audit audit')} in CI and keep the baseline`);
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
  .option('--summary <path>', 'append a Markdown summary to this file')
  .option('--github-output', 'write report-path and failed to $GITHUB_OUTPUT')
  .option('--update-baseline', 'write the audit result to the baseline file')
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
        githubOutput?: boolean;
        updateBaseline?: boolean;
        fail?: boolean;
      },
    ) => {
      const config: PulseConfig = await loadConfig(options.config);

      const runs = parseRuns(options.runs);
      const preset = parsePreset(options.preset);
      if (runs !== undefined) config.runs = runs;
      if (preset !== undefined) config.preset = preset;
      if (options.out !== undefined) config.report.outDir = options.out;
      if (url !== undefined) config.urls = [url];

      const baselineFile = options.baseline ?? baselinePath(config.report.outDir);
      const baseline = await readBaseline(baselineFile);
      const hasAnyBaseline = Object.keys(baseline.results).length > 0;

      if (!hasAnyBaseline) {
        console.error(
          pc.yellow(
            `No baseline at ${baselineFile}. Absolute budgets still apply; use --update-baseline to establish one.`,
          ),
        );
      }

      const results = [];
      for (const target of config.urls) {
        console.error(
          pc.dim(
            `auditing ${target} (${config.runs} measured run${config.runs === 1 ? '' : 's'} + warm-up)…`,
          ),
        );
        results.push(await runAudit(target, config));
      }

      const baselines: Record<string, ReturnType<typeof comparableBaseline>> = {};
      for (const result of results) {
        const raw = baseline.results[result.url];
        const comparable = comparableBaseline(raw, result);
        if (raw && !comparable) {
          console.error(
            pc.yellow(
              `Ignoring baseline for ${result.url}: preset, run count or Lighthouse version changed.`,
            ),
          );
        }
        baselines[result.url] = comparable;
      }

      const report = buildReport(results, baselines, config);
      printReport(report);

      const jsonPath = await writeJsonReport(report, config.report.outDir);
      const htmlPath = await writeHtmlReport(report, config.report.outDir);
      console.log('');
      console.log(`${pc.dim('json')}  ${jsonPath}`);
      console.log(`${pc.dim('html')}  ${htmlPath}`);

      if (options.updateBaseline) {
        await writeBaseline(baselineFile, mergeBaseline(baseline, results));
        console.log(`${pc.dim('baseline')} ${baselineFile}`);
      }

      if (options.summary) {
        await appendFile(options.summary, renderMarkdown(report), 'utf8');
      }

      if (options.githubOutput) {
        const outputPath = process.env.GITHUB_OUTPUT;
        if (!outputPath) {
          console.error(pc.yellow('--github-output was passed but GITHUB_OUTPUT is not set.'));
        } else {
          await appendFile(outputPath, `report-path=${htmlPath}\nfailed=${report.failed}\n`, 'utf8');
        }
      }

      if (report.failed > 0) {
        console.error(pc.red(`${report.failed} check${report.failed === 1 ? '' : 's'} failed.`));
        if (options.fail !== false) process.exitCode = 1;
      }
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof PulseConfigError) {
    console.error(pc.red(error.message));
  } else {
    console.error(pc.red(`pulse: ${(error as Error).message}`));
  }
  process.exitCode = 2;
});
