/**
 * esbuild plugin that makes Lighthouse's published ESM bundleable for Node.
 *
 * Lighthouse already ships a production bundle (the DevTools build) and leaves
 * explicit seams for it: the `bundledModules` map in config-helpers.js, the
 * locale list in format.js, and the axe source in lib/axe.js. This plugin fills
 * those seams at build time with the same values the Lighthouse build script
 * computes, and fails the build if a future Lighthouse release moves one of
 * them. Nothing is edited in node_modules and nothing is patched at runtime.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const lighthouseRoot = path.dirname(require.resolve('lighthouse/package.json'));
const lighthouseVersion = JSON.parse(
  readFileSync(require.resolve('lighthouse/package.json'), 'utf8'),
).version;
const { Runner } = await import('lighthouse/core/runner.js');

const auditPaths = Runner.getAuditList().map((audit) => `../audits/${audit}`);
const gathererPaths = Runner.getGathererList().map((gatherer) => `../gather/gatherers/${gatherer}`);

const files = {
  configHelpers: path.join(lighthouseRoot, 'core/config/config-helpers.js'),
  runner: path.join(lighthouseRoot, 'core/runner.js'),
  root: path.join(lighthouseRoot, 'shared/root.js'),
  format: path.join(lighthouseRoot, 'shared/localization/format.js'),
  i18n: path.join(lighthouseRoot, 'core/lib/i18n/i18n.js'),
  axe: path.join(lighthouseRoot, 'core/lib/axe.js'),
  stacks: path.join(lighthouseRoot, 'core/gather/gatherers/stacks.js'),
  pageFunctions: path.join(lighthouseRoot, 'core/lib/page-functions.js'),
  reportAssets: path.join(lighthouseRoot, 'report/generator/report-assets.js'),
  flowReportAssets: path.join(lighthouseRoot, 'report/generator/flow-report-assets.js'),
};

const locales = readdirSync(path.join(lighthouseRoot, 'shared/localization/locales'))
  .filter((name) => name.endsWith('.json') && !name.endsWith('.ctc.json'))
  .map((name) => name.replace('.json', ''))
  .sort();

function fail(file, expected) {
  throw new Error(
    `Lighthouse bundle: could not find ${expected} in ${path.relative(lighthouseRoot, file)}. ` +
      'Lighthouse changed its bundling seam; update scripts/lighthouse-build.mjs before upgrading.',
  );
}

function replaceOnce(source, from, to, file, label) {
  const index = source.indexOf(from);
  if (index === -1) fail(file, label ?? JSON.stringify(from.slice(0, 80)));
  if (source.indexOf(from, index + from.length) !== -1) {
    throw new Error(`Lighthouse bundle: ${label ?? from} is not unique in ${file}`);
  }
  return `${source.slice(0, index)}${to}${source.slice(index + from.length)}`;
}

/** Replace a `static name() { ... }` method body, matching nested braces. */
function replaceMethod(source, name, body, file) {
  const signature = `static ${name}() {`;
  const start = source.indexOf(signature);
  if (start === -1) fail(file, signature);

  let index = start + signature.length;
  let depth = 1;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    index += 1;
  }
  if (depth !== 0) fail(file, `the end of ${name}()`);

  return `${source.slice(0, start)}static ${name}() {\n    return ${JSON.stringify(body)};\n  }${source.slice(index)}`;
}

/** Replace a `function name() { ... }` body, matching nested braces. */
function replaceFunction(source, name, body, file) {
  const signature = `function ${name}() {`;
  const start = source.indexOf(signature);
  if (start === -1) fail(file, signature);

  let index = start + signature.length;
  let depth = 1;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    index += 1;
  }
  if (depth !== 0) fail(file, `the end of ${name}()`);

  return `${source.slice(0, start)}function ${name}() {\n  ${body}\n}${source.slice(index)}`;
}

export function lighthouseBundlePlugin() {
  return {
    name: 'lighthouse-bundle',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0 || !result.metafile) return;

        const outdir = build.initialOptions.outdir;
        if (!outdir) return;

        // Collect the licenses of every package esbuild actually bundled. The
        // published package must carry Lighthouse's Apache-2.0 text and the
        // notices of everything else in dist.
        const packages = new Set();
        // axe-core and js-library-detector are embedded as source strings by
        // the transforms above, so esbuild never reports them as inputs.
        for (const name of ['axe-core', 'js-library-detector']) packages.add(name);
        for (const input of Object.keys(result.metafile.inputs)) {
          const normalized = path.resolve(input).replaceAll('\\', '/');
          const marker = '/node_modules/';
          const index = normalized.lastIndexOf(marker);
          if (index === -1) continue;
          const parts = normalized.slice(index + marker.length).split('/');
          packages.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
        }

        const sections = [];
        for (const name of [...packages].sort()) {
          let packageDir;
          try {
            packageDir = path.dirname(require.resolve(`${name}/package.json`));
          } catch {
            continue;
          }
          const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
          const licenseFiles = readdirSync(packageDir).filter((file) => /^(licen[cs]e|notice)/i.test(file));
          const texts = licenseFiles.map((file) => readFileSync(path.join(packageDir, file), 'utf8').trim());
          sections.push(
            [
              `${name}@${pkg.version} - ${pkg.license ?? 'license not declared'}`,
              ...(texts.length > 0 ? texts : ['(no license file in the package; see the SPDX id above)']),
            ].join('\n\n'),
          );
        }

        mkdirSync(outdir, { recursive: true });
        writeFileSync(
          path.join(outdir, 'THIRD_PARTY_NOTICES.txt'),
          [
            'pulse-audit bundles the following third-party packages into dist.',
            'Each package is listed with its declared license and license text.',
            '',
            sections.join('\n\n---\n\n'),
            '',
          ].join('\n'),
          'utf8',
        );
      });

      build.onLoad({ filter: /\.js$/ }, (args) => {
        if (!args.path.startsWith(lighthouseRoot + path.sep)) return undefined;

        // The HTML/flow report assets are read from disk at module load and are
        // only used by generateReport, which Pulse never calls. Lighthouse's
        // own browser bundle shims these to empty objects for the same reason.
        if (args.path === files.reportAssets) {
          return { contents: 'export const reportAssets = {};', loader: 'js' };
        }
        if (args.path === files.flowReportAssets) {
          return { contents: 'export const flowReportAssets = {};', loader: 'js' };
        }

        let source = readFileSync(args.path, 'utf8');
        const relative = path.relative(lighthouseRoot, args.path).replaceAll('\\', '/');

        // i18n ids are derived from the source path. Keep the original path so
        // locale lookup and the LHR's icuMessagePaths stay identical.
        if (source.includes('createIcuMessageFn(import.meta.url')) {
          source = source.replaceAll(
            'createIcuMessageFn(import.meta.url,',
            `createIcuMessageFn('${relative}',`,
          );
          source = source.replaceAll(
            'createIcuMessageFn(import.meta.url)',
            `createIcuMessageFn('${relative}')`,
          );
        }

        if (args.path === files.configHelpers) {
          const entries = [...gathererPaths, ...auditPaths]
            .map((modulePath) => `['${modulePath.replace(/\.js$/, '')}', import('${modulePath}')]`)
            .join(',\n');
          source = replaceOnce(
            source,
            '/* BUILD_REPLACE_BUNDLED_MODULES */',
            `[\n${entries},\n]`,
            args.path,
            'the BUILD_REPLACE_BUNDLED_MODULES marker',
          );
        }

        if (args.path === files.runner) {
          source = replaceMethod(source, 'getAuditList', Runner.getAuditList(), args.path);
          source = replaceMethod(source, 'getGathererList', Runner.getGathererList(), args.path);
        }

        if (args.path === files.root) {
          const original = [
            'const LH_ROOT = path.dirname(import.meta.dirname);',
            "const pkg = JSON.parse(fs.readFileSync(`${LH_ROOT}/package.json`, 'utf-8'));",
            'const lighthouseVersion = pkg.version;',
          ].join('\n');
          source = replaceOnce(
            source,
            original,
            [
              'const LH_ROOT = path.dirname(import.meta.dirname);',
              `const lighthouseVersion = ${JSON.stringify(lighthouseVersion)};`,
            ].join('\n'),
            args.path,
            'the package.json version read',
          );
        }

        if (args.path === files.format) {
          const start = source.indexOf('const CANONICAL_LOCALES = fs.readdirSync(');
          if (start === -1) fail(args.path, 'CANONICAL_LOCALES');
          const end = source.indexOf('.sort();', start);
          if (end === -1) fail(args.path, 'the end of CANONICAL_LOCALES');
          source = `${source.slice(0, start)}const CANONICAL_LOCALES = ${JSON.stringify(locales)};${source.slice(
            end + '.sort();'.length,
          )}`;
        }

        if (args.path === files.i18n) {
          source = replaceOnce(
            source,
            'path.relative(LH_ROOT, import.meta.filename)',
            "'core/lib/i18n/i18n.js'",
            args.path,
            'the shared UIStrings path',
          );
        }

        // Lighthouse decides whether to inject the esbuild __name shim into
        // page functions by probing for lighthouse-logger. chrome-launcher
        // keeps that package on disk, so the probe would say "not bundled"
        // even though the page functions are minified. Force the bundled path.
        if (args.path === files.pageFunctions) {
          source = replaceFunction(source, 'isBundledEnvironment', 'return true;', args.path);
        }

        if (args.path === files.axe) {
          const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
          source = replaceOnce(
            source,
            "fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')",
            JSON.stringify(axeSource),
            args.path,
            'the axe-core source read',
          );
        }

        if (args.path === files.stacks) {
          const detectorSource = readFileSync(
            require.resolve('js-library-detector/library/libraries.js'),
            'utf8',
          );
          source = replaceOnce(
            source,
            `fs.readFileSync(
  require.resolve('js-library-detector/library/libraries.js'), 'utf8')`,
            JSON.stringify(detectorSource),
            args.path,
            'the js-library-detector source read',
          );
        }

        return { contents: source, loader: 'js' };
      });
    },
  };
}

export { lighthouseVersion };
