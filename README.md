# Pulse

**Performance, accessibility and page-weight budgets that survive CI.**

Pulse audits a deployed URL, compares the result to your last green `main` build, and fails
the pull request only when something got worse — with a report that names the element,
request or axe rule responsible.

> **Status: v0.2.0 is the current release.** Install/run with
> `npx @mtlh/pulse-audit@0.2.0`. It adds baseline v3, readable config units, per-URL budgets,
> authenticated UI/API timing checks, WSL support and the new CLI surface. Public repo:
> `github.com/mtlh/pulse-audit`.

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
npx @mtlh/pulse-audit@0.2.0 init --from https://example.com

# 2. First run establishes the baseline
npx @mtlh/pulse-audit@0.2.0 audit --update-baseline

# 3. Verify and open the report
npx @mtlh/pulse-audit@0.2.0 audit
# .pulse/report.html
```

During development:

```bash
npm run dev -- init https://example.com
npm run dev -- audit
npm test
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
  "timeoutMs": 120000,
  "warmup": "navigate",
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
  (default `120000`).
- `warmup` controls what happens before the measured page runs. `"navigate"` (default)
  preloads the page once in a plain Chrome tab, which warms DNS, TLS, the server and the JS
  compiler without paying for a full Lighthouse audit. `"full"` keeps the old behaviour of
  running and discarding a complete Lighthouse run; `"none"` starts cold. The first measured
  run is still reported like any other, so the median is unchanged. API endpoints are not
  warmed up.
- A rule must set `max` or `regression`; an accessibility rule must set `maxViolations`,
  `maxNew` or `maxNewByImpact`. Inert rules are rejected at load time.

Metrics: LCP, CLS, TBT, FCP, TTFB, JavaScript, CSS, fonts, images, total transfer weight,
requests, third-party bytes, third-party requests, and accessibility violations. API results
add TTFB, total duration, HTTP status and response body bytes. Each audit also stores one
sample per measured run so the report can show min/median/max spread.

### UI and API tables

The terminal, Markdown and HTML reports keep **UI pages** and **API timings** in separate
tables. API checks report TTFB, total duration, HTTP status and response size, and compare
against an API baseline keyed by method and URL. A status outside 2xx–3xx warns by default;
set `expectStatus` on the endpoint to make a specific code or list of codes a hard check.
API baselines are ignored when the measured run count changes, just like UI baselines.

Read [docs/budgets.md](https://github.com/mtlh/pulse-audit/blob/main/docs/budgets.md) for the
exact pass/fail semantics, impact buckets and `ignoreRules`.

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
but keeps errors and a failure line; JSON output still prints.

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

## Use in CI

Pulse is a CLI, so it works in any runner that has Node and Chrome:

```yaml
- run: npx @mtlh/pulse-audit@0.2.0 doctor --skip-network
- run: npx @mtlh/pulse-audit@0.2.0 audit --runs 3 --summary "$GITHUB_STEP_SUMMARY" --github-output
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
npm test          # unit tests + no-Chrome user flows
npm run test:e2e  # fixture audits, baseline flow, packed install
npm run battle-test  # live portfolio sequence
```

The E2E suite uses a deterministic local fixture (`test/flows/fixture.ts`) with a slow hero
image, injected layout shift, missing alt text and a 220 KB script. Chrome is required;
`npm test` skips those flows when `PULSE_E2E` is not set. `npm run battle-test` writes
`.pulse/battle-test.md` with the derived minimums, verified metrics and forced-regression
result.

## Layout

```
src/
  cli.ts            command wiring
  doctor.ts         environment and project checks
  chrome.ts         Chrome/WSL detection and fallbacks
  version.ts        version read from package.json
  config.ts         zod schema, units, defaults and per-URL resolution
  auth.ts           ${ENV_VAR} expansion, bearer/basic headers
  runner.ts         chrome-launcher + Lighthouse, median of N
  api.ts            authenticated fetch timing, median of N
  extract.ts        LHR → the metrics Pulse cares about
  compare.ts        budget + baseline evaluation for UI and API
  report.ts         report assembly
  baseline.ts       baseline read/write/migration, comparability
  format.ts         value formatting and HTML escaping
  reporters/        terminal, JSON, Markdown, self-contained HTML, shared spread
  util/             units, median, variance and impact ordering
test/               unit tests + CLI/user flows
```

## License

MIT
