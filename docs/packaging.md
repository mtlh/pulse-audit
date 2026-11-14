# Packaging and install size

Pulse is consumed with `npx`, so the install matters as much as the CLI. This
document records how the package is built, what it costs to install, and which
options were rejected.

The reproducible measurement is `npm run size:report`. It runs `npm pack`,
installs the tarball into a clean temporary directory with `--omit=dev`, traces
module and file access, and times `--version`, `doctor` and a deterministic
fixture audit. Chrome is required for the audit; pass `--skip-audit` to measure
only the package and startup paths. The generated baseline lives in
[`packaging-baseline.md`](packaging-baseline.md).

## Before and after

Both columns were measured on Windows 11 x64, Node 24.12.0, with a warm npm
cache. The baseline is `origin/main` at `489c18a`, built without the packaging
changes; the final column is this branch. The fixture audit is the same local
page in `test/flows/fixture.ts`.

| Metric                                     |                     Baseline |                      Final |                             Change |
| ------------------------------------------ | ---------------------------: | -------------------------: | ---------------------------------: |
| `npm pack` tarball                         |            0.1 MB (76 files) |         3.3 MB (308 files) |        code moved into the package |
| Clean production install                   | 163.1 MB across 110 packages | 47.1 MB across 24 packages |                           **−71%** |
| Clean install time (warm cache)            |                      10.31 s |                     4.26 s |                           **−59%** |
| `dist/` on disk                            |            0.5 MB (73 files) |        21.2 MB (305 files) |                vendored Lighthouse |
| `dist/` sourcemaps                         |            0.3 MB (35 files) |                          0 |                            removed |
| `pulse --version` median (min)             |                83 ms (81 ms) |              72 ms (69 ms) |              fewer startup modules |
| `pulse doctor --skip-network` median (min) |              265 ms (261 ms) |            231 ms (222 ms) | bundled zod/chrome-launcher chunks |
| `pulse audit --runs 1` (fixture)           |                       6.79 s |                     6.92 s |                        noise-level |
| Module files loaded by `audit`             |                          831 |                        548 |                        fewer files |
| Fixture LCP / CLS / TBT                    |           2401.16 / 0.07 / 0 |         2401.20 / 0.07 / 0 |                               same |
| Fixture JS / images / requests             |      225526 B / 164654 B / 4 |    225526 B / 164654 B / 4 |                               same |
| Fixture a11y violations                    |                            3 |                          3 |                               same |

The tarball itself is larger because Lighthouse now ships inside it. The user
download is not: before, `npx` fetched a 0.1 MB tarball plus a 163.1 MB
production tree; now it fetches a 3.3 MB tarball plus a 47.1 MB tree. The clean
install size includes the package's own 21.2 MB of bundled code.

The original packaging audit on this machine measured 167.3 MB across 126
packages. The difference is measurement method: the report sums files from a
fresh tarball install in a temporary directory (which dedupes slightly
differently), not an existing checkout.

### Behaviour comparison on a live URL

Three-run medians for `https://mtlh.vercel.app/`, unbundled vs bundled:

| Metric          |  Unbundled |    Bundled |
| --------------- | ---------: | ---------: |
| LCP             | 1229.14 ms | 1225.64 ms |
| CLS             |          0 |          0 |
| TBT             |          0 |          0 |
| FCP             |  956.04 ms |  959.62 ms |
| TTFB            |   22.00 ms |   20.00 ms |
| JavaScript      |     1229 B |     1228 B |
| Images          |    14322 B |    14318 B |
| Requests        |          8 |          8 |
| Failed requests |          0 |          0 |
| Long tasks      |          1 |          1 |
| Console errors  |          0 |          0 |
| A11y nodes      |          0 |          0 |

LCP, FCP, TTFB, JavaScript and image bytes move inside normal run-to-run
variance; CLS, TBT, requests, failed requests, long tasks, console errors and
a11y violations are identical, the LCP element is the same, and both builds
pass the same eight checks. The deterministic fixture in `npm run test:e2e` is
the stronger proof: it lands on identical values before and after.

## What changed

### Build output

- Source maps are no longer published. They were half of `dist/` and are not
  used by an installed CLI.
- Whitespace and syntax minification stay on. Identifier minification is off:
  esbuild emits a separate `__name` helper per chunk, and Lighthouse injects
  one helper name into page functions. Renaming identifiers made those names
  disagree across chunks and broke page evaluates.
- `keepNames` preserves function names in stack traces.

### Bundled dependencies

`commander`, `picocolors`, `chrome-launcher` and Lighthouse are built into
`dist/` with esbuild. The published runtime dependencies are now only
`puppeteer-core` and `zod`:

- `puppeteer-core` stays external. Pulse uses it for the warm-up navigation and
  Lighthouse uses it for the audit; bundling Puppeteer is unsupported and
  would be the riskiest part of the tree.
- `zod` stays external because `dist/index.d.ts` imports its types. Bundling
  the runtime while leaving the types unresolved would break TypeScript
  consumers.

`@sentry/node` is deliberately external and no longer installed. Lighthouse
imports it dynamically only when its CLI error reporting flag is on, which
Pulse never sets. That single decision removes roughly 45 MB of Sentry
packages that the audit never loaded (see the baseline table: every
`@sentry/*` row is "loaded by audit: no").

### Vendoring Lighthouse

`src/lighthouse.ts` is the only import of `lighthouse`. tsup marks it
`noExternal`, so it becomes a lazily loaded chunk; `--version`, `doctor` and
the library entry point never load it. `src/lighthouse-version.ts` exposes the
bundled version to `doctor` without pulling in the runtime.

Lighthouse already supports bundling for its DevTools build and leaves explicit
seams. `scripts/lighthouse-build.mjs` fills them at build time; no file in
`node_modules` is edited and nothing is monkey-patched at runtime:

- `bundledModules` in `core/config/config-helpers.js` is replaced with static
  imports for every audit and gatherer.
- `Runner.getAuditList()` and `Runner.getGathererList()` return static lists
  instead of reading directories.
- `shared/root.js` gets the build-time version instead of reading
  `package.json`.
- `shared/localization/format.js` gets the locale list as a literal, and every
  `createIcuMessageFn(import.meta.url, ...)` uses the original source path so
  i18n ids, and therefore translations, do not change.
- `axe-core` and `js-library-detector` sources are inlined where Lighthouse
  reads them from disk and injects them into the page.
- `report-assets.js` and `flow-report-assets.js` are shimmed to empty objects.
  They are only used by `generateReport`, which Pulse never calls, and
  Lighthouse's own browser bundle does the same.
- `isBundledEnvironment()` is forced to `true`. It normally probes for
  `lighthouse-logger`, which can be hoisted by another package, and a false
  negative would leave minified page functions without their helper.

Every transform asserts that the expected text exists and appears once. A
Lighthouse upgrade that moves a seam fails `npm run build` instead of shipping
a subtly broken audit.

`dist/THIRD_PARTY_NOTICES.txt` is generated from the esbuild metafile and
contains the declared license and license text of every bundled package,
including Lighthouse (Apache-2.0), axe-core (MPL-2.0) and js-library-detector
(MIT).

`--fast` imports the same inlined axe source and axe version through
`src/axe.ts`, so its results stay comparable with a Lighthouse baseline without
resolving `axe-core` from disk. The source is imported lazily, so a normal
audit does not pay for the 600 KB axe bundle.

## Verification

```bash
npm run typecheck
npm test
npm run test:e2e          # fixture audits, baseline flows, packed install + audit
npm run size:report       # baseline/final tables
```

`npm run test:e2e` runs the packed tarball through `npm pack` + a clean install
and audits the fixture through the installed binary, so the bundled path is
what the flows exercise.

## Rejected options

### Stripping Lighthouse locales

Lighthouse ships about 14 MB of locale JSON. Removing it would make `dist/`
roughly a third smaller, but Lighthouse picks the locale from the operating
system. A German or Japanese machine would silently fall back to English audit
titles, which is a behaviour change. The locale data stays.

### Forcing `@sentry/node` out with npm overrides

Published packages cannot override a dependency's dependency tree for
consumers; `overrides` only applies at the root of the consuming project.
Vendoring Lighthouse is the only reliable way to drop the unused Sentry tree.

### Bundling `puppeteer-core`

`puppeteer-core`, `chromium-bidi`, `devtools-protocol` and their small helpers
are about 19 MB of the remaining 47 MB. Puppeteer relies on dynamic requires and
its own package layout; bundling it is unsupported and would put the audit at
risk for a few megabytes that are already below the target.

### Single-file binaries

Node SEA, `bun build --compile` and `deno compile` were considered and rejected:

- All three produce a **per-platform executable**, so npm delivery would need a
  matrix of platform packages (Windows/macOS/Linux × x64/arm64). `npx` would
  pull a large artifact instead of a pure-JS tarball, and the release workflow
  would have to build and attest every target.
- Node SEA needs a single bundled entry point and does not support the dynamic
  ESM chunks that keep Lighthouse lazy. It also embeds the Node runtime, so a
  build is roughly 100 MB per platform, more than twice the current install.
- Bun and Deno were not installed on the measurement machine, so Windows +
  Linux + macOS could not all be proven green. Neither runtime is a supported
  replacement for Node's ESM/CJS interop, `import.meta` and CDP behaviour here,
  and the brief forbids switching runtimes.

The honest floor with the current runtime and dependency set is about 47 MB:
21.2 MB of bundled Lighthouse (including locales), about 20 MB of
puppeteer-core and its tree, 5.9 MB of zod, plus their small helpers.

## Upgrading Lighthouse

```bash
npm install lighthouse@<new-version> --save-dev
npm run build
npm run test:e2e
npm run size:report
```

If the build plugin reports a missing seam, compare the new Lighthouse source
with `scripts/lighthouse-build.mjs` before changing it. If the fixture audit
metrics or a11y violations move, do not ship the upgrade; keep the previous
version and open a follow-up.
