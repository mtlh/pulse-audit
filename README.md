# Pulse

**Performance, accessibility and page-weight budgets that survive CI.**

Pulse audits a deployed URL, compares the result to your last green `main` build, and fails
the pull request only when something got worse — with a report that names the element,
request or axe rule responsible.

> **Status: v0.1.0.** Published on npm as `pulse-audit`. The Lighthouse path, baseline flow,
> HTML report, CLI flows and packed install are verified locally. Use it through `npx`.

## Why another performance tool

Lighthouse CI can assert budgets. Unlighthouse crawls. pa11y-ci checks accessibility. Size
Limit checks JavaScript. None of them give you one budget file, one report, and one CI check
covering speed, accessibility and page weight — compared against the branch you are about to
merge into.

Pulse is the workflow layer, not a new measurement engine. It uses Lighthouse for the audit
and focuses on:

- **Baseline deltas** instead of flaky absolute scores.
- **Median of N runs**, with the warm-up discarded.
- **New accessibility violations**, so existing debt does not block adoption.
- **One self-contained HTML report** you can attach to a PR.
- **One config file** that defines every minimum in one place.

## Quick start

```bash
# 1. Create a config, measured from the page you care about
npx pulse-audit@0.1.0 init --from https://example.com

# 2. First run establishes the baseline
npx pulse-audit@0.1.0 audit --update-baseline

# 3. Verify and open the report
npx pulse-audit@0.1.0 audit
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
the default location.

## Config

```json
{
  "preset": "mobile",
  "runs": 3,
  "urls": ["https://example.com/"],
  "budgets": {
    "lcp": { "max": 2500, "regression": 10 },
    "cls": { "max": 0.05, "regression": 20 },
    "tbt": { "max": 200, "severity": "warn" },
    "js": { "max": 250000 },
    "images": { "max": 600000 },
    "requests": { "max": 90 },
    "a11y": { "maxViolations": 0, "maxNew": 0 }
  },
  "report": { "outDir": ".pulse" }
}
```

Read [docs/budgets.md](./docs/budgets.md) for the exact pass/fail semantics.

## CLI

```
pulse init [urls...]        Create .pulse.json
  --from <url>              Measure this URL and derive initial budgets
  --out <path>              Config path (default .pulse.json)
  --force                   Overwrite an existing config
pulse audit [url]           Audit and compare
  -c, --config <path>       Config path (default .pulse.json)
  -r, --runs <n>            Measured runs (one warm-up is discarded)
      --preset <preset>     mobile or desktop
      --baseline <path>     Baseline file
      --out <dir>           Report output directory
      --summary <path>      Append a Markdown summary
      --github-output       Write report-path and failed to $GITHUB_OUTPUT
      --update-baseline     Save this run as the baseline
      --no-fail             Always exit 0
```

Exit codes: `0` pass, `1` budget failure, `2` tool or config error.

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

## Use in CI

Pulse is a CLI, so it works in any runner that has Node and Chrome:

```yaml
- run: npx pulse-audit@0.1.0 audit --runs 3 --summary "$GITHUB_STEP_SUMMARY" --github-output
```

On the default branch, add `--update-baseline` and keep `.pulse/baseline.json` between runs
(the CLI writes it; upload it as an artifact or cache it however your CI prefers). Pull-request
runs compare against that file and exit non-zero on regressions or new accessibility debt.

## Layout

```
src/
  cli.ts            command wiring
  config.ts         zod schema + defaults
  runner.ts         chrome-launcher + Lighthouse, median of N
  extract.ts        LHR → the metrics Pulse cares about
  compare.ts        budget + baseline evaluation
  report.ts         report assembly
  baseline.ts       baseline read/write, comparability
  reporters/        terminal, JSON, Markdown, self-contained HTML
test/               unit tests + CLI/user flows
```

## License

MIT
