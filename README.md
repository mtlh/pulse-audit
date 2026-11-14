# Pulse

**Performance, accessibility and page-weight budgets that survive CI.**

Pulse audits a deployed URL, compares the result to your last green `main` build, and fails
the pull request only when something got worse — with a report that names the element,
request or axe rule responsible.

> **Status: v0.2.1 is the current release.** Install/run with
> `npx @mtlh/pulse-audit@0.2.1`. It adds baseline v3, readable config units, per-URL budgets,
> authenticated UI/API timing checks, WSL support and the new CLI surface. Public repo:
> `github.com/mtlh/pulse-audit`.
>
> v0.2.1 is a dependency refresh: Lighthouse 13, Puppeteer 25, Zod 4 and Commander 15. It
> requires Node >= 22.19.0, the minimum for Lighthouse 13.

## Why another performance tool

Lighthouse CI can assert budgets. Unlighthouse crawls. pa11y-ci checks accessibility. Size
Limit checks JavaScript. None of them give you one budget file, one report, and one CI check
covering speed, accessibility and page weight — compared against the branch you are about to
merge into.

Pulse is the workflow layer, not a new measurement engine. It uses Lighthouse for the audit
and focuses on:

- **Baseline deltas** instead of flaky absolute scores.
- **Median of N runs**, with a navigation warm-up and the spread reported.
- **New accessibility violations**, broken down by impact, so existing debt does not block
  adoption.
- **Authenticated pages and APIs**, with bearer tokens or Basic credentials from the
  environment and separate UI/API timing tables.
- **One self-contained HTML report** you can attach to a PR.
- **One config file** that defines every minimum in one place.

## Quick start

```bash
# 1. Create a config, measured from the page you care about
npx @mtlh/pulse-audit@0.2.1 init --from https://example.com

# 2. First run establishes the baseline
npx @mtlh/pulse-audit@0.2.1 audit --update-baseline

# 3. Verify and open the report
npx @mtlh/pulse-audit@0.2.1 audit
# .pulse/report.html
```

During development:

```bash
npm run dev -- init https://example.com
npm run dev -- audit
npm test
npm run lint
npm run typecheck
```

Chrome must be installed. Pulse uses `chrome-launcher`; set `CHROME_PATH` if Chrome is not in
the default location. Run `pulse doctor` to check Node, Chrome, the config, the baseline,
the report directory and URL reachability in one screen.

## WSL

Pulse runs inside the WSL distro, so it needs a **Linux** Chrome/Chromium in that distro. A
Windows `chrome.exe` is not a reliable target: its DevTools port lives on the Windows side and
WSL usually cannot reach it. Install Chrome for Linux:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install ./google-chrome-stable_current_amd64.deb
```

Chromium installed through snap (`/snap/bin/chromium`) or Flatpak is also detected. If the
binary lives somewhere else, point at it explicitly:

```bash
export CHROME_PATH=/usr/bin/google-chrome
pulse doctor
```

`pulse doctor` reports when it detects WSL, whether the Chrome binary is a Linux build, and
where it was found. Pulse already launches Chrome with `--no-sandbox` and
`--disable-dev-shm-usage`, which are the two flags WSL and containers normally need.

## Config

Every budget accepts readable units. Durations can be numbers of milliseconds or strings such
as `"2.5s"`; bytes can be numbers or `"250kb"` / `"1.5mb"` (1 KB = 1024 bytes); regressions
are percentages (`10` or `"10%"`); CLS and counts are numbers.

```json
{
  "preset": "mobile",
  "runs": 3,
  "strict": false,
  "retries": 1,
  "timeoutMs": 45000,
  "warmup": "navigate",
  "concurrency": 2,
  "urls": [
    "https://example.com/",
    {
      "url": "https://staging.example.com/app",
      "preset": "desktop",
      "runs": 5,
      "auth": { "type": "bearer", "token": "${PULSE_TOKEN}" },
      "budgets": {
        "js": { "max": "900kb" },
        "thirdPartyRequests": { "max": 10 }
      }
    }
  ],
  "api": [
    {
      "url": "https://api.example.com/v1/items",
      "method": "GET",
      "auth": { "type": "bearer", "token": "${PULSE_TOKEN}" },
      "runs": 3,
      "expectStatus": [200],
      "budgets": {
        "ttfb": { "max": "300ms", "regression": 20 },
        "duration": { "max": "800ms", "regression": 20 }
      }
    }
  ],
  "apiBudgets": {
    "ttfb": { "regression": 20, "severity": "warn" },
    "duration": { "regression": 20, "severity": "warn" }
  },
  "budgets": {
    "lcp": { "max": "2.5s", "regression": "10%" },
    "cls": { "max": 0.05, "regression": 20 },
    "tbt": { "max": "200ms", "severity": "warn" },
    "fcp": { "max": "1.8s", "regression": 15 },
    "ttfb": { "max": "800ms", "regression": 20, "severity": "warn" },
    "js": { "max": "250kb" },
    "css": { "max": "100kb", "severity": "warn" },
    "fonts": { "max": "300kb", "severity": "warn" },
    "images": { "max": "600kb" },
    "total": { "max": "1.5mb", "severity": "warn" },
    "requests": { "max": 90 },
    "failedRequests": { "max": 0, "regression": 0 },
    "thirdPartyBytes": { "max": "300kb", "severity": "warn" },
    "thirdPartyRequests": { "max": 20, "severity": "warn" },
    "a11y": {
      "maxViolations": 0,
      "maxNew": 0,
      "maxNewByImpact": { "critical": 0, "serious": 0 }
    }
  },
  "report": { "outDir": ".pulse" }
}
```

- `urls` entries may be plain strings or objects with `preset`, `runs`, `auth` and `budgets`
  overrides. Page budgets deep-merge over the global block. An API-only project can set
  `"urls": []`; every config needs at least one page URL or API endpoint.
- `api` entries are measured with Node's `fetch`, not Lighthouse. They support `method`,
  `headers`, `body`, `auth`, `runs`, `timeoutMs`, `expectStatus` and their own `budgets`.
  `apiBudgets` supplies defaults that each endpoint deep-merges over.
- `auth` is `{ "type": "bearer", "token": "..." }` or
  `{ "type": "basic", "username": "...", "password": "..." }`. Values support `${ENV_VAR}`
  expansion, so secrets stay in CI. Authentication is resolved at run time and is never
  written to the report or baseline.
- Authenticated page audits send the header to every request in the Lighthouse run, including
  third-party requests. Use a token scoped to the staging/test environment.
- API runs are not warmed up: `runs` requests are executed, so POST/PUT/PATCH/DELETE targets
  repeat their side effect. Use `runs: 1` for unsafe methods when that matters.
- `strict: true` makes an absolute `max` breach fail even when the metric improved versus
  the baseline. Warnings stay warnings. Without `strict`, an `error` rule that is over `max`
  but improving passes as a ratchet; a `warn` rule still reports a warning.
- `retries` is the number of extra attempts after a failed Lighthouse or API request
  (default `1`).
- `timeoutMs` maps to Lighthouse `maxWaitForLoad` and to the API request timeout
  (default `45000`, Lighthouse's own page-load default). A page that cannot reach a quiet
  network in that window is usually waiting on a stalled third-party request; waiting longer
  only slows CI, and every retry doubles the delay.
- `warmup` controls what happens before the measured page runs. `"navigate"` (default)
  preloads the page once in a plain Chrome tab, which warms DNS, TLS, the server and the JS
  compiler without paying for a full Lighthouse audit. `"full"` keeps the old behaviour of
  running and discarding a complete Lighthouse run; `"none"` starts cold. The first measured
  run is still reported like any other, so the median is unchanged. API endpoints are not
  warmed up. The navigation warm-up is capped at 10 s, so a stalled page cannot delay the
  measured runs indefinitely.
- `audit` prints one progress line for the warm-up and for each measured run (`run 1/3 6.2s`),
  so a slow audit is visible in CI instead of looking hung between the start line and the
  report. With more than one URL each line is prefixed with the URL, so overlapping runs stay
  attributable.
- `concurrency` is the maximum number of **different URLs** audited at once (default `2`,
  range `1`–`8`). Runs for one URL always stay sequential, and the report keeps config order.
  Concurrency `1` reuses one Chrome for every URL in the invocation. Values above `1` use one
  Chrome plus one worker lane per URL because Chrome allows only one tracing session at a time;
  set `concurrency: 1` on a small CI runner or when you want the most conservative timings.
- A rule must set `max` or `regression`; an accessibility rule must set `maxViolations`,
  `maxNew` or `maxNewByImpact`. Inert rules are rejected at load time.

Metrics: LCP, CLS, TBT, FCP, TTFB, JavaScript, CSS, fonts, images, total transfer weight,
requests, failed requests, third-party bytes, third-party requests, third-party main-thread
time, long main-thread tasks, console errors, and accessibility violations. A request counts as
failed when it returns 4xx/5xx or never finishes; redirects do not count. API results add TTFB,
total duration, HTTP status and response body bytes. Each audit also stores one sample per
measured run so the report can show min/median/max spread.

### UI and API tables

The terminal, Markdown and HTML reports keep **UI pages** and **API timings** in separate
tables. API checks report TTFB, total duration, HTTP status and response size, and compare
against an API baseline keyed by method and URL. A status outside 2xx–3xx warns by default;
set `expectStatus` on the endpoint to make a specific code or list of codes a hard check.
API baselines are ignored when the measured run count changes, just like UI baselines.

Read [docs/budgets.md](https://github.com/mtlh/pulse-audit/blob/main/docs/budgets.md) for the
exact pass/fail semantics, impact buckets and `ignoreRules`.

## Speed: Chrome reuse, concurrency and `--fast`

### One Chrome per audit command

`pulse audit` launches Chrome once, warms it up, and reuses it for every URL's warm-up and
measured runs. `runAudit(url, options)` still launches and kills its own browser, so library
callers see no change.

Measured on a Windows dev box (16 logical cores, Lighthouse 13.6, Node 24), **4 in-memory
fixture URLs, 3 runs each, navigate warm-up**:

| Version                     | Wall time | Chrome launches |
| --------------------------- | --------: | --------------: |
| Before (one Chrome per URL) |    62.0 s |               4 |
| After, `--concurrency 1`    |    58.7 s |               1 |
| After, `--concurrency 2`    |    30.2 s |               2 |

Reusing one Chrome saves about 0.7 s per extra URL; overlapping URLs at concurrency 2 roughly
halves wall time again. The commands used were:

```bash
node dist/cli.js audit --concurrency 1   # and --concurrency 2, and the pre-change build
npx tsx scripts/bench.mjs --fixture 4 --runs 3 --concurrency 2
```

### Concurrency drift

Lighthouse's `simulate` throttling observes real main-thread work and then simulates the
network, so parallel Chromes can inflate the observed timings. The default was chosen from
measurements, not intuition. Median of four URLs, `runs: 3`, navigate warm-up:

| Target  | Concurrency |     LCP |  CLS |  TBT |     FCP |    TTFB |   Bytes | Requests | Wall time |
| ------- | ----------: | ------: | ---: | ---: | ------: | ------: | ------: | -------: | --------: |
| Fixture |           1 | 2401 ms | .075 | 0 ms | 1801 ms |  0–1 ms | 391,925 |        4 |    58.3 s |
| Fixture |           2 | 2401 ms | .075 | 0 ms | 1801 ms |  0–1 ms | 391,925 |        4 |    31.2 s |
| Fixture |           4 | 2401 ms | .075 | 0 ms | 1801 ms |  0–1 ms | 391,925 |        4 |    18.8 s |
| Live    |           1 | 1226 ms |    0 | 0 ms | 1002 ms | 20.5 ms |  97,456 |        8 |    64.6 s |
| Live    |           2 | 1229 ms |    0 | 0 ms | 1004 ms | 22.5 ms |  97,411 |        8 |    35.1 s |
| Live    |           4 | 1229 ms |    0 | 0 ms | 1010 ms | 21.0 ms |  97,340 |        8 |    21.3 s |

The largest median drift was **+0.25% LCP** at concurrency 2 and 4 on the live page; the TTFB
change was a 2 ms absolute move on a 20 ms warning-level metric. No pass/fail check flipped at
any level. The default is **2**: it was the highest level that stays comfortably inside the 5%
bound while matching the two vCPUs most hosted runners expose. Concurrency 4 also measured
inside the bound on this 16-core box, but remains opt-in (`--concurrency 4`) because it will
over-subscribe a small runner. Keep `concurrency: 1` when the timings themselves are the
subject of the run or the machine has fewer than two free cores.

Reproduce the table:

```bash
npm run build
npx tsx scripts/bench.mjs --fixture 4 --runs 3 --concurrency 1 --json
npx tsx scripts/bench.mjs --url https://mtlh.vercel.app/ --runs 3 --concurrency 2 --json
```

`scripts/bench.mjs` prints Chrome/import startup, each warm-up and measured run, browser
shutdown and report assembly, plus the resulting metrics.

### `--fast` (opt-in local pre-check)

`pulse audit --fast` loads the page once in Chrome, measures the byte/request profile and runs
the exact axe bundle Lighthouse depends on. It skips the 5–6 s Lighthouse pipeline only when it
can prove the result is safe:

- a comparable baseline must exist, and the axe rule/node-count fingerprint must match it;
- every configured size/count budget must be comfortably inside its max (not within 10%) and
  inside its regression tolerance;
- if any timing metric (`lcp`, `cls`, `tbt`, `fcp`, `ttfb`), `failedRequests`, `longTasks`,
  `thirdPartyMainThread` or `consoleErrors` has a budget, the pre-check escalates immediately,
  because those numbers cannot be compared to a Lighthouse baseline without Lighthouse;
- any navigation error, changed a11y finding, near-limit budget or missing baseline escalates
  to a full Lighthouse run for that URL.

The command always prints a warning because performance budgets are **not fully enforced** in
this mode. `--fast` never writes a baseline (`--update-baseline` is ignored with a warning), and
fast report entries carry `method: "fast"` plus the `enforcedBudgets` list in terminal, HTML,
Markdown and JSON output. Do not use it in CI examples; it exists for local dev loops where a
clean size/a11y-only config can skip Lighthouse. `--fast` runs URLs one at a time and ignores
`--concurrency`.

## CLI

```
pulse init [urls...]        Create .pulse.json
  --from <url>              Measure this URL with the configured run count and derive budgets
  --out <path>              Config path (default .pulse.json)
  --force                   Overwrite an existing config

pulse audit [url]           Audit and compare
  -c, --config <path>       Config path (default .pulse.json)
  -r, --runs <n>            Measured runs (UI discards one warm-up; API runs exactly n)
      --preset <preset>     mobile or desktop
      --baseline <path>     Baseline file
      --out <dir>           Report output directory
      --summary <path>      Write a Markdown summary (the pulse block is replaced)
      --retries <n>         Extra attempts after a failed Lighthouse run or API request
      --timeout <ms>        Lighthouse maxWaitForLoad and API request timeout
      --warmup <mode>       Warm-up for page runs: navigate (default), full or none
      --concurrency <n>     Audit up to n page URLs at once (default 2, range 1-8)
      --fast                Cheap local pre-check; escalates when it cannot prove a clean result
      --github-output       Write report-path and counts to $GITHUB_OUTPUT
      --update-baseline     Save this run as the baseline
      --json                Print only the report JSON to stdout
      --quiet               Suppress the table and paths
      --fail-on <level>     error (default), warn or none
      --no-fail             Alias for --fail-on none

pulse baseline show         Show preset, URL, capturedAt, runs, LCP and Lighthouse version
  --baseline <path>         Baseline file (default .pulse/baseline.json)

pulse baseline prune        Remove entries that are no longer in the config
  -c, --config <path>       Config path (default .pulse.json)
  --baseline <path>         Baseline file (defaults to the config report outDir)
  --dry-run                 Show what would be removed without writing

pulse doctor                Check Node, Chrome, config, baseline, report dir and URLs
  -c, --config <path>       Config path (default .pulse.json)
  --baseline <path>         Baseline file (defaults to the config report outDir)
  --skip-network            Skip URL reachability checks
```

`--json` keeps stdout machine-readable: the report is the only thing printed there, while
progress, paths and warnings go to stderr. `--quiet` suppresses the table, paths and warnings
but keeps errors and a failure line; JSON output still prints. The `--fast` warning is always
printed, even with `--quiet` or `--json`, because it changes what the gate enforces.

`--fast` is deliberately excluded from the CI examples: it is a local pre-check, not a
replacement for the full Lighthouse gate.

### Exit codes

| Code | Meaning                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------- |
| `0`  | Every check passed, or `--fail-on none` / `--no-fail` was used.                                     |
| `1`  | A check failed, or any check warned while `--fail-on warn` is set.                                  |
| `2`  | Config or tool error, or one or more URLs could not be audited. Successful URLs are still reported. |

A partial baseline is never written: `--update-baseline` is skipped when any URL fails to
audit.

## Breaking changes in 0.2.0

- **Baseline v3.** Page results are keyed by `preset::url`, so mobile and desktop baselines
  coexist. API results are stored separately and keyed by `api::METHOD::url`. Version 1 and 2
  files are migrated automatically on read and rewritten as version 3 on the next
  `--update-baseline`; no manual action is required.
- **`runAudit` API.** `runAudit(url, config)` became
  `runAudit(url, { preset, runs, retries, timeoutMs, auth })`.
- **`buildReport` API.** Positional arguments became `buildReport(inputs)` where each input is
  `{ result, baseline, config }` with the per-URL resolved config.
- `AuditMetrics` gained `fcp`, `ttfb`, `css`, `fonts`, `total`, `thirdPartyBytes` and
  `thirdPartyRequests`; `AuditResult` gained `samples` and `thirdPartyHeaviest`.
- **Report JSON schema v3.** `PulseReport.version` is `"3"` and adds `apiResults` for API
  endpoints. `presets`, expanded metrics and samples are retained.
- `--summary` now replaces its `<!-- pulse:start -->` block instead of appending a duplicate
  section.

## Report schema v4

`PulseReport.version` is `"4"`. Each UI report entry now also carries:

- `method`: `"lighthouse"` or `"fast"`.
- `enforcedBudgets`: the budget metrics a fast pre-check actually checked. Absent for
  Lighthouse entries.

Baselines are still version 3; the report version is independent of the baseline format.

## Use in CI

Pulse is a CLI, so it works in any runner that has Node and Chrome:

```yaml
- run: npx @mtlh/pulse-audit@0.2.1 doctor --skip-network
- run: npx @mtlh/pulse-audit@0.2.1 audit --runs 3 --summary "$GITHUB_STEP_SUMMARY" --github-output
```

`--github-output` appends `report-path`, `failed`, `failed-count`, `warned-count` and
`audit-errors` to `$GITHUB_OUTPUT`, so later steps can upload the HTML report or branch on the
result. `failed` is true when any check failed or any URL could not be audited.

On the default branch, add `--update-baseline` and keep `.pulse/baseline.json` between runs
(the CLI writes it; upload it as an artifact or cache it however your CI prefers). Pull-request
runs compare against that file and exit non-zero on regressions or new accessibility debt.
Use `pulse baseline prune` when a URL leaves the config.

## Releasing

Bump `version` in `package.json`, commit, and push to `main`:

```bash
npm version patch --no-git-tag-version
git commit -am "v$(node -p "require('./package.json').version")"
git push
```

`.github/workflows/release.yml` runs the checks, publishes only if that version is not already
on npm, waits for the registry, then creates the matching Git tag and GitHub release. The
workflow needs an `NPM_TOKEN` repository secret with publish rights to `@mtlh`. If npm stages
the version for review, approve it on npmjs.com and re-run the workflow.

## Testing

```bash
npm run lint      # strict type-aware ESLint rules
npm run format:check
npm run typecheck
npm test          # unit tests + no-Chrome user flows
npm run test:e2e  # fixture audits, baseline flow, packed install
npm run battle-test  # live portfolio sequence
npm run bench -- --fixture 4 --runs 3 --concurrency 2  # per-phase timings
```

`eslint.config.js` enables `typescript-eslint`'s strict type-aware preset plus explicit
correctness rules: no floating promises, no unsafe `any` flow, exhaustive switches, import
cycles, atomic async updates and promise-rejection errors. CI runs the same `npm run lint`
gate as the build and test jobs.

The E2E suite uses a deterministic local fixture (`test/flows/fixture.ts`) with a slow hero
image, injected layout shift, missing alt text and a 220 KB script. Chrome is required;
`npm test` skips those flows when `PULSE_E2E` is not set. `npm run test:e2e` also covers
multi-URL concurrency and the `--fast` escalation path. `npm run battle-test` writes
`.pulse/battle-test.md` with the derived minimums, verified metrics and forced-regression
result. Benchmark the local fixture with `npx tsx scripts/bench.mjs --fixture 4` or point it at
a URL/config with `--url` / `--config`.

## Architecture

The metric list, budget schema, labels, formatting and fast-path classification all derive
from one registry (`src/metrics.ts`), and every reporter renders through the shared
`CheckView` (`src/checks.ts`). See [docs/architecture.md](docs/architecture.md) for the
module boundaries and the checklist for adding a metric.

## Layout

```
src/
  cli.ts            command wiring
  doctor.ts         environment and project checks
  chrome.ts         Chrome/WSL detection and fallbacks
  version.ts        version read from package.json
  metrics.ts        metric registry: keys, labels, formats, parsers, fast lanes
  checks.ts         check presentation shared by every reporter
  config.ts         zod schema, units, defaults and per-URL resolution
  auth.ts           ${ENV_VAR} expansion, bearer/basic headers
  runner.ts         chrome-launcher + Lighthouse, audit session, worker lanes, median of N
  audit-worker.ts   one concurrency lane: its own Chrome and Lighthouse module
  scheduler.ts      bounded, order-preserving concurrency
  fast.ts           opt-in axe/network pre-check and escalation rules
  api.ts            authenticated fetch timing, median of N
  extract.ts        LHR → the metrics Pulse cares about
  compare.ts        budget + baseline evaluation for UI and API
  report.ts         report assembly
  baseline.ts       baseline read/write/migration, comparability
  format.ts         value formatting and HTML escaping
  reporters/        terminal, JSON, Markdown, self-contained HTML, shared spread
  util/             files, errors, guards, requests, text, units, median, variance, a11y
test/               unit tests + CLI/user flows
```

## License

MIT
