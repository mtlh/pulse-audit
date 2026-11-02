# Pulse

**Performance, accessibility and page-weight budgets that survive CI.**

Pulse audits a deployed URL, compares the result to your last green `main` build, and fails
the pull request only when something got worse — with a report that names the element,
request or axe rule responsible.

> **Status: v0.1.0 is live on npm.** Install/run with
> `npx @mtlh/pulse-audit@0.1.0`. This tree also contains unreleased changes (baseline v2,
> readable config units, per-URL budgets, WSL support and the new CLI surface) that are not
> published yet. Public repo: `github.com/mtlh/pulse-audit`.

## Why another performance tool

Lighthouse CI can assert budgets. Unlighthouse crawls. pa11y-ci checks accessibility. Size
Limit checks JavaScript. None of them give you one budget file, one report, and one CI check
covering speed, accessibility and page weight — compared against the branch you are about to
merge into.

Pulse is the workflow layer, not a new measurement engine. It uses Lighthouse for the audit
and focuses on:

- **Baseline deltas** instead of flaky absolute scores.
- **Median of N runs**, with the warm-up discarded and the spread reported.
- **New accessibility violations**, broken down by impact, so existing debt does not block
  adoption.
- **One self-contained HTML report** you can attach to a PR.
- **One config file** that defines every minimum in one place.

## Quick start

```bash
# 1. Create a config, measured from the page you care about
npx @mtlh/pulse-audit@0.1.0 init --from https://example.com

# 2. First run establishes the baseline
npx @mtlh/pulse-audit@0.1.0 audit --update-baseline

# 3. Verify and open the report
npx @mtlh/pulse-audit@0.1.0 audit
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
  "urls": [
    "https://example.com/",
    {
      "url": "https://example.com/app",
      "preset": "desktop",
      "runs": 5,
      "budgets": {
        "js": { "max": "900kb" },
        "thirdPartyRequests": { "max": 10 }
      }
    }
  ],
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

- `urls` entries may be plain strings or objects with `preset`, `runs` and `budgets`
  overrides. Page budgets deep-merge over the global block.
- `strict: true` makes an absolute `max` breach fail even when the metric improved versus
  the baseline. Warnings stay warnings.
- `retries` is the number of extra attempts after a failed Lighthouse run (default `1`).
- `timeoutMs` maps to Lighthouse `maxWaitForLoad` (default `120000`).
- A rule must set `max` or `regression`; an accessibility rule must set `maxViolations`,
  `maxNew` or `maxNewByImpact`. Inert rules are rejected at load time.

Metrics: LCP, CLS, TBT, FCP, TTFB, JavaScript, CSS, fonts, images, total transfer weight,
requests, third-party bytes, third-party requests, and accessibility violations. Each audit
also stores one sample per measured run so the report can show min/median/max spread.

Read [docs/budgets.md](./docs/budgets.md) for the exact pass/fail semantics, impact buckets
and `ignoreRules`.

## CLI

```
pulse init [urls...]        Create .pulse.json
  --from <url>              Measure this URL with the configured run count and derive budgets
  --out <path>              Config path (default .pulse.json)
  --force                   Overwrite an existing config

pulse audit [url]           Audit and compare
  -c, --config <path>       Config path (default .pulse.json)
  -r, --runs <n>            Measured runs (one warm-up is discarded)
      --preset <preset>     mobile or desktop
      --baseline <path>     Baseline file
      --out <dir>           Report output directory
      --summary <path>      Write a Markdown summary (the pulse block is replaced)
      --retries <n>         Extra attempts after a failed Lighthouse run
      --timeout <ms>        Lighthouse maxWaitForLoad
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
progress, paths and warnings go to stderr. `--quiet` suppresses the table and paths but keeps
errors and a failure line; JSON output still prints.

### Exit codes

| Code | Meaning                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------- |
| `0`  | Every check passed, or `--fail-on none` / `--no-fail` was used.                                     |
| `1`  | A check failed, or any check warned while `--fail-on warn` is set.                                  |
| `2`  | Config or tool error, or one or more URLs could not be audited. Successful URLs are still reported. |

A partial baseline is never written: `--update-baseline` is skipped when any URL fails to
audit.

## Breaking changes in this 0.1.0 tree

- **Baseline v2.** Results are keyed by `preset::url`, so mobile and desktop baselines
  coexist. Version 1 files are migrated automatically on read and rewritten as version 2 on
  the next `--update-baseline`; no manual action is required.
- **`runAudit` API.** `runAudit(url, config)` became
  `runAudit(url, { preset, runs, retries, timeoutMs })`.
- **`buildReport` API.** Positional arguments became `buildReport(inputs)` where each input is
  `{ result, baseline, config }` with the per-URL resolved config.
- `AuditMetrics` gained `fcp`, `ttfb`, `css`, `fonts`, `total`, `thirdPartyBytes` and
  `thirdPartyRequests`; `AuditResult` gained `samples` and `thirdPartyHeaviest`.
- **Report JSON schema v2.** `PulseReport.version` is `"2"`, adds `presets`, and includes the
  expanded metrics and samples.
- `--summary` now replaces its `<!-- pulse:start -->` block instead of appending a duplicate
  section.

## Use in CI

Pulse is a CLI, so it works in any runner that has Node and Chrome:

```yaml
- run: npx @mtlh/pulse-audit@0.1.0 doctor --skip-network
- run: npx @mtlh/pulse-audit@0.1.0 audit --runs 3 --summary "$GITHUB_STEP_SUMMARY" --github-output
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
  version.ts        version read from package.json
  config.ts         zod schema, units and defaults
  runner.ts         chrome-launcher + Lighthouse, median of N
  extract.ts        LHR → the metrics Pulse cares about
  compare.ts        budget + baseline evaluation
  report.ts         report assembly
  baseline.ts       baseline read/write/migration, comparability
  reporters/        terminal, JSON, Markdown, self-contained HTML
test/               unit tests + CLI/user flows
```

## License

MIT
