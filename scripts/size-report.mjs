#!/usr/bin/env node
/**
 * Repeatable packaging report for @mtlh/pulse-audit.
 *
 * Reports the published tarball, a clean production install, the largest
 * production packages and whether each one is loaded at runtime, plus dist
 * and startup timings. Run `npm run build` first: the report measures the
 * current dist exactly as `npm pack` would ship it.
 *
 * Usage:
 *   node scripts/size-report.mjs [--skip-audit] [--keep] [--title <text>]
 *                                [--markdown <path>] [--json <path>]
 *
 * Chrome is required for the fixture audit. Use --skip-audit on machines
 * without Chrome; the package, install and startup numbers still work.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const MB = 1024 * 1024;

const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(name);
}
function option(name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

const skipAudit = flag('--skip-audit');
const keep = flag('--keep');
const title = option('--title', `Packaging report for @mtlh/pulse-audit`);
const markdownPath = option('--markdown');
const jsonPath = option('--json');

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules/npm/bin/npm-cli.js'),
  ];
  const found = candidates.find((candidate) => Boolean(candidate && existsSync(candidate)));
  if (!found) throw new Error('Could not find npm-cli.js; run this script through npm.');
  return found;
}

async function run(command, args, options = {}) {
  const started = performance.now();
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, NO_COLOR: '1', ...options.env },
      timeout: options.timeout ?? 600_000,
      maxBuffer: 64 * MB,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr, durationMs: performance.now() - started };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error),
      durationMs: performance.now() - started,
    };
  }
}

async function walkFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      files.push({ path: full, size: (await statFile(full)).size });
    }
  }
  return files;
}

async function statFile(file) {
  try {
    return await stat(file);
  } catch {
    return { size: 0 };
  }
}

function sum(files) {
  return files.reduce((total, file) => total + file.size, 0);
}

/** Sum of a package directory, skipping nested node_modules (counted separately). */
async function packageSize(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await packageSize(full);
    else if (entry.isFile()) total += (await statFile(full)).size;
  }
  return total;
}

async function collectPackages(nodeModules, found = []) {
  let entries;
  try {
    entries = await readdir(nodeModules, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(nodeModules, entry.name);
      for (const child of await readdir(scopeDir, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const name = `${entry.name}/${child.name}`;
        await addPackage(path.join(scopeDir, child.name), name, found);
      }
    } else {
      await addPackage(path.join(nodeModules, entry.name), entry.name, found);
    }
  }
  return found;
}

async function addPackage(dir, name, found) {
  found.push({ name, size: await packageSize(dir), copies: 1 });
  await collectPackages(path.join(dir, 'node_modules'), found);
}

function aggregatePackages(packages) {
  const byName = new Map();
  for (const pkg of packages) {
    const existing = byName.get(pkg.name);
    if (existing) {
      existing.size += pkg.size;
      existing.copies += 1;
    } else {
      byName.set(pkg.name, { ...pkg });
    }
  }
  return [...byName.values()].sort((a, b) => b.size - a.size);
}

function touchedPackageFiles(traceFile) {
  const files = new Set();
  if (existsSync(traceFile)) {
    for (const url of readFileSync(traceFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      files.add(fileURLToPath(url).replaceAll('\\', '/'));
    }
  }
  const fileTrace = `${traceFile}.files`;
  if (existsSync(fileTrace)) {
    for (const file of readFileSync(fileTrace, 'utf8').split(/\r?\n/).filter(Boolean)) {
      files.add(file.replaceAll('\\', '/'));
    }
  }
  return [...files].filter((file) => file.includes('/node_modules/'));
}

function packageWasLoaded(loaded, name) {
  const needle = `/node_modules/${name}/`;
  return loaded.some((file) => file.includes(needle));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mb(bytes) {
  return `${(bytes / MB).toFixed(1)} MB`;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)} s`;
}

function ms(value) {
  return `${Math.round(value)} ms`;
}

async function moduleTraceHooks(dir) {
  const hook = path.join(dir, 'trace-hook.mjs');
  const register = path.join(dir, 'trace-register.mjs');
  await writeFile(
    hook,
    `import { appendFileSync } from 'node:fs';
const out = process.env.PULSE_TRACE_FILE;
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (out && result.url.startsWith('file:')) appendFileSync(out, result.url + '\\n');
  return result;
}
`,
    'utf8',
  );
  await writeFile(
    register,
    `import { appendFileSync } from 'node:fs';
import fs from 'node:fs';
import { register } from 'node:module';

// Some dependencies (axe-core is the important one) are read from disk with
// fs.readFileSync instead of being imported. Record those reads so a package
// that is only resolved as an asset still counts as used by the audit.
const fileTrace = process.env.PULSE_FILE_TRACE;
if (fileTrace) {
  const record = (value) => {
    if (typeof value !== 'string' || !value.includes('node_modules')) return;
    try {
      appendFileSync(fileTrace, value + '\\n');
    } catch {}
  };
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function (target, ...rest) {
    record(target);
    return readFileSync.call(this, target, ...rest);
  };
  const readFile = fs.readFile;
  fs.readFile = function (target, ...rest) {
    record(target);
    return readFile.call(this, target, ...rest);
  };
  const readFilePromise = fs.promises.readFile;
  fs.promises.readFile = function (target, ...rest) {
    record(target);
    return readFilePromise.call(this, target, ...rest);
  };
}

register(new URL('./trace-hook.mjs', import.meta.url));
`,
    'utf8',
  );
  return register;
}

async function tracedRun(cli, args, traceFile, traceRegister, options) {
  const fileTrace = `${traceFile}.files`;
  await writeFile(traceFile, '', 'utf8');
  await writeFile(fileTrace, '', 'utf8');
  const result = await run(process.execPath, ['--import', pathToFileURL(traceRegister).href, cli, ...args], {
    ...options,
    env: { ...options?.env, PULSE_TRACE_FILE: traceFile, PULSE_FILE_TRACE: fileTrace },
  });
  const urls = existsSync(traceFile)
    ? [...new Set((await readFile(traceFile, 'utf8')).split(/\r?\n/).filter(Boolean))]
    : [];
  return { result, urls, fileTrace };
}

async function startFixture() {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'scripts/fixture-server.ts')],
    {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('fixture server did not start')), 30_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/https?:\/\/\S+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0].trim());
      }
    });
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture server exited (${code}): ${buffer}`));
    });
  });

  return {
    url,
    async close() {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

function passingConfig(url) {
  return {
    preset: 'mobile',
    runs: 1,
    strict: false,
    retries: 0,
    timeoutMs: 120_000,
    urls: [url],
    budgets: {
      lcp: { max: 10_000, regression: 50 },
      cls: { max: 1, regression: 50 },
      tbt: { max: 1_000, regression: 50, severity: 'warn' },
      fcp: { max: 10_000, regression: 50 },
      ttfb: { max: 10_000, regression: 50, severity: 'warn' },
      js: { max: 1_000_000, regression: 50 },
      css: { max: 1_000_000, regression: 50, severity: 'warn' },
      fonts: { max: 1_000_000, regression: 50, severity: 'warn' },
      images: { max: 1_000_000, regression: 50 },
      total: { max: 5_000_000, regression: 50, severity: 'warn' },
      requests: { max: 50, regression: 50 },
      thirdPartyBytes: { max: 1_000_000, regression: 50, severity: 'warn' },
      thirdPartyRequests: { max: 50, regression: 50, severity: 'warn' },
      a11y: { maxViolations: 10, maxNew: 5 },
    },
    report: { outDir: '.pulse' },
  };
}

async function main() {
  const distDir = path.join(repoRoot, 'dist');
  if (!existsSync(path.join(distDir, 'cli.js'))) {
    throw new Error('dist/cli.js is missing. Run `npm run build` before the size report.');
  }

  const distFiles = await walkFiles(distDir);
  const distJs = distFiles.filter((file) => file.path.endsWith('.js'));
  const distMaps = distFiles.filter((file) => file.path.endsWith('.map'));
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));

  const work = await mkdtemp(path.join(tmpdir(), 'pulse-size-'));
  const packDir = path.join(work, 'pack');
  const consumer = path.join(work, 'consumer');
  const traceDir = path.join(work, 'trace');
  await mkdir(packDir, { recursive: true });
  await mkdir(consumer, { recursive: true });
  await mkdir(traceDir, { recursive: true });

  try {
    const packed = await run(process.execPath, [npmCli(), 'pack', '--json', '--pack-destination', packDir], {
      cwd: repoRoot,
      timeout: 120_000,
    });
    if (packed.code !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`);
    const [info] = JSON.parse(packed.stdout);
    const tarball = path.join(packDir, info.filename);
    const tarStat = await statFile(tarball);

    await writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify({ name: 'pulse-size-consumer', private: true, type: 'module' }, null, 2),
      'utf8',
    );
    const installed = await run(
      process.execPath,
      [npmCli(), 'install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', tarball],
      { cwd: consumer, timeout: 900_000 },
    );
    if (installed.code !== 0) throw new Error(`clean install failed:\n${installed.stderr}`);

    const nodeModules = path.join(consumer, 'node_modules');
    const installedFiles = await walkFiles(nodeModules);
    const packageFiles = installedFiles.filter((file) => path.basename(file.path) === 'package.json');
    const packages = aggregatePackages(await collectPackages(nodeModules));

    const packageCli = path.join(nodeModules, '@mtlh', 'pulse-audit', 'dist', 'cli.js');
    const traceRegister = await moduleTraceHooks(traceDir);

    const versionTrace = await tracedRun(
      packageCli,
      ['--version'],
      path.join(traceDir, 'version.txt'),
      traceRegister,
      { cwd: consumer },
    );
    if (versionTrace.result.code !== 0) {
      throw new Error(`packed --version failed:\n${versionTrace.result.stderr}`);
    }

    // Warm the filesystem cache before timing; report the median of five runs.
    await run(process.execPath, [packageCli, '--version'], { cwd: consumer });
    const versionTimes = [];
    for (let i = 0; i < 7; i += 1) {
      const runResult = await run(process.execPath, [packageCli, '--version'], { cwd: consumer });
      versionTimes.push(runResult.durationMs);
    }

    const fixture = skipAudit ? undefined : await startFixture();
    try {
      // Doctor skips the network, so a placeholder URL keeps the check
      // measurable even when Chrome (and therefore the fixture) is absent.
      const doctorConfig = passingConfig(fixture?.url ?? 'https://example.com/');
      await writeFile(
        path.join(consumer, '.pulse.json'),
        `${JSON.stringify(doctorConfig, null, 2)}\n`,
        'utf8',
      );
      const doctorTimes = [];
      let doctorResult;
      for (let i = 0; i < 3; i += 1) {
        doctorResult = await run(process.execPath, [packageCli, 'doctor', '--skip-network'], {
          cwd: consumer,
        });
        doctorTimes.push(doctorResult.durationMs);
      }

      let audit;
      let report;
      let auditTraceUrls = [];
      if (fixture) {
        const config = passingConfig(fixture.url);
        await writeFile(path.join(consumer, '.pulse.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        audit = await run(process.execPath, [packageCli, 'audit', '--runs', '1'], {
          cwd: consumer,
          timeout: 600_000,
        });
        if (audit.code !== 0) {
          throw new Error(`fixture audit failed:\n${audit.stdout}\n${audit.stderr}`);
        }
        // Read before the traced run overwrites the report.
        report = JSON.parse(await readFile(path.join(consumer, '.pulse', 'report.json'), 'utf8'));

        const auditTrace = await tracedRun(
          packageCli,
          ['audit', '--runs', '1', '--quiet'],
          path.join(traceDir, 'audit.txt'),
          traceRegister,
          { cwd: consumer, timeout: 600_000 },
        );
        auditTraceUrls = auditTrace.urls;
      }

      const versionLoaded = touchedPackageFiles(path.join(traceDir, 'version.txt'));
      const auditLoaded = touchedPackageFiles(path.join(traceDir, 'audit.txt'));

      const result = {
        title,
        measurement: {
          date: new Date().toISOString(),
          node: process.versions.node,
          platform: `${process.platform} ${process.arch}`,
          version: packageJson.version,
          lighthouseVersion: JSON.parse(
            await readFile(path.join(nodeModules, 'lighthouse', 'package.json'), 'utf8'),
          ).version,
        },
        package: {
          tarballBytes: tarStat.size,
          unpackedBytes: info.unpackedSize,
          fileCount: info.entryCount ?? info.files.length,
          files: info.files.map((file) => file.path),
        },
        install: {
          bytes: sum(installedFiles),
          packageCount: packages.length,
          packageJsonCount: packageFiles.length,
          durationMs: installed.durationMs,
        },
        dist: {
          bytes: sum(distFiles),
          files: distFiles.length,
          jsBytes: sum(distJs),
          jsFiles: distJs.length,
          mapBytes: sum(distMaps),
          mapFiles: distMaps.length,
        },
        startup: {
          version: {
            medianMs: median(versionTimes),
            minMs: Math.min(...versionTimes),
            runsMs: versionTimes,
            modules: versionTrace.urls.length,
            nodeModules: versionLoaded.length,
          },
          doctor: doctorTimes.length
            ? {
                medianMs: median(doctorTimes),
                minMs: Math.min(...doctorTimes),
                runsMs: doctorTimes,
                ok: doctorResult?.code === 0,
              }
            : undefined,
          audit: audit
            ? {
                durationMs: audit.durationMs,
                modules: auditTraceUrls.length,
                nodeModules: auditLoaded.length,
                metrics: report?.results?.[0]?.audit?.metrics,
                violations: report?.results?.[0]?.audit?.violations?.length,
                lighthouseVersion: report?.results?.[0]?.audit?.lighthouseVersion,
              }
            : undefined,
        },
        packages: packages.slice(0, 15).map((pkg) => ({
          name: pkg.name,
          size: pkg.size,
          copies: pkg.copies,
          loadedByVersion: packageWasLoaded(versionLoaded, pkg.name),
          loadedByAudit: packageWasLoaded(auditLoaded, pkg.name),
        })),
      };

      const markdown = await formatMarkdown(renderMarkdown(result));
      console.log(markdown);
      if (markdownPath) {
        await mkdir(path.dirname(path.resolve(markdownPath)), { recursive: true });
        await writeFile(markdownPath, markdown, 'utf8');
      }
      if (jsonPath) {
        await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      }
    } finally {
      if (fixture) await fixture.close();
    }
  } finally {
    if (!keep) await rm(work, { recursive: true, force: true });
    else console.error(`kept ${work}`);
  }
}

async function formatMarkdown(markdown) {
  try {
    const prettier = await import('prettier');
    return await prettier.format(markdown, { parser: 'markdown' });
  } catch {
    // The report is still readable without the dev-only formatter.
    return markdown;
  }
}

function renderMarkdown(result) {
  const lines = [];
  const audit = result.startup.audit;
  lines.push(`# ${result.title}`, '');
  lines.push(
    `Measured ${result.measurement.date} on Node ${result.measurement.node} (${result.measurement.platform}) ` +
      `against \`@mtlh/pulse-audit@${result.measurement.version}\` with Lighthouse ${result.measurement.lighthouseVersion}.`,
    '',
  );
  lines.push('## Package and install', '');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| npm pack tarball | ${mb(result.package.tarballBytes)} (${result.package.fileCount} files) |`);
  lines.push(`| Unpacked package | ${mb(result.package.unpackedBytes)} |`);
  lines.push(
    `| Clean production install | ${mb(result.install.bytes)} across ${result.install.packageCount} packages |`,
  );
  lines.push(`| Clean install time | ${seconds(result.install.durationMs)} (warm npm cache) |`);
  lines.push('');

  lines.push('## dist', '');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| dist total | ${mb(result.dist.bytes)} (${result.dist.files} files) |`);
  lines.push(`| dist JavaScript | ${mb(result.dist.jsBytes)} (${result.dist.jsFiles} files) |`);
  lines.push(`| dist sourcemaps | ${mb(result.dist.mapBytes)} (${result.dist.mapFiles} files) |`);
  lines.push('');

  lines.push('## Startup and audit', '');
  lines.push('| Command | Median (min) | Modules loaded |');
  lines.push('| --- | --- | --- |');
  lines.push(
    `| \`pulse --version\` | ${ms(result.startup.version.medianMs)} (${ms(result.startup.version.minMs)}) | ${result.startup.version.modules} module files (${result.startup.version.nodeModules} in node_modules) |`,
  );
  if (result.startup.doctor) {
    lines.push(
      `| \`pulse doctor --skip-network\` | ${ms(result.startup.doctor.medianMs)} (${ms(result.startup.doctor.minMs)}) | not traced |`,
    );
  }
  if (audit) {
    lines.push(
      `| \`pulse audit --runs 1\` (fixture) | ${seconds(audit.durationMs)} | ${audit.modules} module files (${audit.nodeModules} in node_modules) |`,
    );
  }
  lines.push('');

  lines.push('## Largest production packages', '');
  lines.push(
    '| Package | On disk | Copies | Loaded by `--version` | Loaded by `audit` |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const pkg of result.packages) {
    lines.push(
      `| \`${pkg.name}\` | ${mb(pkg.size)} | ${pkg.copies} | ${pkg.loadedByVersion ? 'yes' : 'no'} | ${
        pkg.loadedByAudit ? 'yes' : 'no'
      } |`,
    );
  }
  lines.push('');

  if (audit) {
    lines.push('## Fixture audit', '');
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    const metrics = audit.metrics ?? {};
    for (const [key, value] of Object.entries(metrics)) {
      lines.push(`| ${key} | ${typeof value === 'number' ? Math.round(value * 100) / 100 : value} |`);
    }
    lines.push(`| a11y violations | ${audit.violations ?? 'n/a'} |`);
    lines.push(`| Lighthouse version in LHR | ${audit.lighthouseVersion ?? 'n/a'} |`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
